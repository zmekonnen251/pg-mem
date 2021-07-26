import { Schema, IMemoryDb, ISchema, TableEvent, GlobalEvent, QueryError, IBackup, MemoryDbOptions, ISubscription, LanguageCompiler } from './interfaces';
import { _IDb, _ISelection, _ITable, _Transaction, _ISchema, _FunctionDefinition, GLOBAL_VARS } from './interfaces-private';
import { DbSchema } from './schema';
import { initialize } from './transforms/transform-base';
import { buildSelection } from './transforms/selection';
import { buildAlias } from './transforms/alias';
import { buildFilter } from './transforms/build-filter';
import { Adapters } from './adapters';
import { Transaction } from './transaction';
import { buildGroupBy } from './transforms/aggregation';
import { buildLimit } from './transforms/limit';
import { buildUnion } from './transforms/union';
import { buildDistinct } from './transforms/distinct';
import { buildOrderBy } from './transforms/order-by';
import { setupPgCatalog } from './schema/pg-catalog';
import { setupInformationSchema } from './schema/information-schema';
import { QName } from 'pgsql-ast-parser';
import { asSingleQName } from './utils';

export function newDb(opts?: MemoryDbOptions): IMemoryDb {
    initialize({
        buildSelection,
        buildAlias,
        buildFilter,
        buildGroupBy,
        buildLimit,
        buildUnion,
        buildOrderBy,
        buildDistinct,
    });
    // root transaction
    const root = Transaction.root();
    const globals = root.getMap(GLOBAL_VARS)
        .set('server_version', '12.2 (pg-mem)');
    root.set(GLOBAL_VARS, globals);

    // create db
    return new MemoryDb(root, undefined, opts ?? {});
}

class MemoryDb implements _IDb {

    private handlers = new Map<TableEvent | GlobalEvent, Set<(...args: any[]) => any>>();
    private schemas = new Map<string, _ISchema>();

    schemaVersion = 1;

    readonly adapters: Adapters = new Adapters(this);
    private extensions: { [name: string]: (schema: ISchema) => void } = {};
    private languages: { [name: string]: LanguageCompiler } = {};
    readonly searchPath = ['pg_catalog', 'public'];

    get public() {
        return this.getSchema(null)
    }

    onSchemaChange() {
        this.schemaVersion++;
        this.raiseGlobal('schema-change', this);
    }

    constructor(public data: Transaction, schemas?: Map<string, _ISchema>, readonly options: MemoryDbOptions = {}) {
        if (!schemas) {
            this.createSchema('public');
        } else {
            this.schemas = schemas;
        }
        setupPgCatalog(this);
        setupInformationSchema(this);
    }

    backup(): IBackup {
        return new Backup(this);
    }

    registerExtension(name: string, install: (schema: ISchema) => void): this {
        this.extensions[name] = install;
        return this;
    }

    registerLanguage(languageName: string, compiler: LanguageCompiler): this {
        this.languages[languageName.toLowerCase()] = compiler;
        return this;
    }

    getLanguage(name: string): LanguageCompiler {
        const ret = this.languages[name.toLowerCase()];
        if (!ret) {
            throw new QueryError(`Unkonwn language "${name}". If you plan to use a script language, you must declare it to pg-mem via ".registerLanguage()"`);
        }
        return ret;
    }


    getExtension(name: string): (schema: ISchema) => void {
        const ret = this.extensions[name];
        if (!ret) {
            throw new Error('Extension does not exist: ' + name);
        }
        return ret;
    }


    createSchema(name: string): DbSchema {
        if (this.schemas.has(name)) {
            throw new Error('Schema exists: ' + name);
        }
        this.onSchemaChange();
        const ret = new DbSchema(name, this);
        this.schemas.set(name, ret);
        return ret;
    }

    getTable(name: string): _ITable;
    getTable(name: string, nullIfNotExists?: boolean): _ITable | null {
        return this.public.getTable(name, nullIfNotExists);
    }

    *getFunctions(name: string | QName, arrity: number): Iterable<_FunctionDefinition> {
        const asSingle = asSingleQName(name);
        if (asSingle) {
            for (const sp of this.searchPath) {
                yield* this.getSchema(sp).getFunctions(name, arrity, true);
            }
        } else {
            const q = name as QName;
            yield* this.getSchema(q.schema!).getFunctions(q.name, arrity, true);
        }
    }


    on(event: GlobalEvent | TableEvent, handler: (...args: any[]) => any): ISubscription {
        let lst = this.handlers.get(event);
        if (!lst) {
            this.handlers.set(event, lst = new Set());
        }
        lst.add(handler);
        return {
            unsubscribe: () => lst?.delete(handler),
        };
    }

    raiseTable(table: string, event: TableEvent): void {
        const got = this.handlers.get(event);
        for (const h of got ?? []) {
            h(table);
        }
    }

    raiseGlobal(event: GlobalEvent, ...data: any[]): void {
        const got = this.handlers.get(event);
        for (const h of got ?? []) {
            h(...data);
        }
    }


    getSchema(db?: string | null, nullIfNotFound?: false): _ISchema;
    getSchema(db: string, nullIfNotFound: true): _ISchema | null;
    getSchema(db?: string | null, nullIfNotFound?: boolean): _ISchema | null {
        db = db ?? 'public';
        const got = this.schemas.get(db);
        if (!got) {
            if (nullIfNotFound) {
                return null;
            }
            throw new QueryError('schema not found: ' + db);
        }
        return got;
    }

    listSchemas() {
        return [...this.schemas.values()];
    }

}

class Backup implements IBackup {
    private readonly data: Transaction;
    private readonly schemaVersion: number;
    constructor(private db: MemoryDb) {
        this.data = db.data.clone();
        this.schemaVersion = db.schemaVersion;
    }

    restore() {
        if (this.schemaVersion !== this.db.schemaVersion) {
            throw new Error('You cannot restore this backup: schema has been changed since this backup has been created => prefer .clone() in this kind of cases.');
        }
        this.db.data = this.data.clone();
    }
}