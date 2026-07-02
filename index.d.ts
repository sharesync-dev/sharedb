// Type definitions for ShareDB
// Project: https://github.com/share/sharedb
// Definitions by: Claude Code <https://claude.ai/code>

/// <reference types="node" />

import { EventEmitter } from 'events';

declare namespace ShareDB {
  // ===============================
  // Core Types and Interfaces
  // ===============================

  type Json = string | number | boolean | null | JsonArray | JsonObject;
  interface JsonArray extends Array<Json> {}
  interface JsonObject { [key: string]: Json }

  // Base operation type - operations are type-specific and vary by OT implementation
  type Op = any;

  // JSON0 Operations (for reference, but Op should remain generic)
  interface Json0Op {
    p: (string | number)[]; // Path
    od?: any; // Old data (object delete)
    oi?: any; // Object insert
    na?: number; // Number add
    li?: any; // List insert  
    ld?: any; // List delete
    lm?: number; // List move
    si?: string; // String insert
    sd?: string; // String delete
    t?: string; // Subtype
  }

  // Rich Text Operations (for reference)
  interface RichTextOp {
    retain?: number;
    insert?: string | object;
    delete?: number;
    attributes?: { [key: string]: any };
  }

  // Text Operations (for reference)
  interface TextOp {
    retain?: number;
    insert?: string;
    delete?: number;
  }

  interface RawOp {
    src?: string;
    seq?: number;
    v?: number;
    op?: Op[]; // Type-specific operations array
    create?: {
      type: string; // OT type name (e.g., 'json0', 'rich-text', 'text')
      data?: any;
    };
    del?: boolean;
    m?: { [key: string]: any }; // Metadata
  }

  interface Snapshot {
    id: string;
    v: number;
    type: string | null;
    data?: any;
    m?: SnapshotMeta;
  }

  interface SnapshotMeta {
    ctime?: number;
    mtime?: number;
    [key: string]: any;
  }

  interface ShareDBError {
    code: number;
    message: string;
  }

  interface Presence {
    [key: string]: any;
  }

  type Callback<T = any> = (error: ShareDBError | null, result?: T) => void;
  type OpCallback = (error: ShareDBError | null) => void;

  // ===============================
  // OT Type System
  // ===============================

  interface OTType {
    name: string;
    uri: string;
    create(snapshot?: any): any;
    apply(snapshot: any, op: Op[]): any;
    compose(op1: Op[], op2: Op[]): Op[];
    transform(op1: Op[], op2: Op[], priority: 'left' | 'right'): Op[];
    invert?(op: Op[]): Op[];
    normalize?(op: Op[]): Op[];
    transformPresence?(presence: any, op: Op[], isOwn: boolean): any;
    serialize?(snapshot: any): any;
    deserialize?(snapshot: any): any;
    diff?(oldSnapshot: any, newSnapshot: any): Op[];
  }

  interface OTTypeMap {
    [typeName: string]: OTType;
  }

  interface TypesModule {
    defaultType: OTType;
    map: OTTypeMap;
    register(type: OTType): void;
  }

  // ===============================
  // Backend Types
  // ===============================

  interface BackendOptions {
    db?: DB;
    pubsub?: PubSub;
    extraDbs?: { [name: string]: DB };
    milestoneDb?: MilestoneDB;
    suppressPublish?: boolean;
    maxSubmitRetries?: number;
    presence?: boolean;
    doNotForwardSendPresenceErrorsToClient?: boolean;
    doNotCommitNoOps?: boolean;
  }

  interface MiddlewareContext {
    agent?: Agent;
    collection: string;
    id: string;
    backend: Backend;
    snapshot?: Snapshot;
    op?: RawOp;
    query?: any;
    request?: any;
    [key: string]: any;
  }

  type Middleware = (context: MiddlewareContext, callback: Callback) => void;

  interface DB {
    commit(collection: string, id: string, op: RawOp, snapshot: Snapshot, callback: Callback): void;
    getSnapshot(collection: string, id: string, callback: Callback<Snapshot>): void;
    getSnapshotBulk(collection: string, ids: string[], callback: Callback<Snapshot[]>): void;
    getOps(collection: string, id: string, from: number, to: number, callback: Callback<RawOp[]>): void;
    getOpsToSnapshot(collection: string, id: string, from: number, snapshot: number, callback: Callback<RawOp[]>): void;
    query(collection: string, query: any, fields: any, options: any, callback: Callback): void;
    queryPoll(collection: string, query: any, options: any, callback: Callback): void;
    queryPollDoc(collection: string, id: string, query: any, options: any, callback: Callback): void;
    canPollDoc(collection: string, query: any): boolean;
    skipPoll(collection: string, id: string, query: any, options: any): boolean;
    close(callback?: Callback): void;
  }

  interface MemoryDB extends DB {
    docs: { [collection: string]: { [id: string]: Snapshot } };
    ops: { [collection: string]: { [id: string]: RawOp[] } };
    getSnapshot(collection: string, id: string, callback: Callback<Snapshot>): void;
    allowSnapshotType(type: string): boolean;
  }

  interface PubSub {
    publish(channels: string[], data: any, callback?: Callback): void;
    subscribe(channel: string, callback: (data: any) => void): void;
    unsubscribe(channel: string, callback: (data: any) => void): void;
    close(callback?: Callback): void;
  }

  interface MilestoneDB {
    getMilestoneSnapshot(collection: string, id: string, version: number, callback: Callback<Snapshot>): void;
    saveMilestoneSnapshot(collection: string, snapshot: Snapshot, callback: Callback): void;
    close(callback?: Callback): void;
  }

  interface Agent extends EventEmitter {
    backend: Backend;
    stream: any;
    connectTime: number;
    custom: any;

    close(): void;
    trigger(action: string, request: any, callback?: Callback): void;
  }

  interface Backend extends EventEmitter {
    readonly db: DB;
    readonly pubsub: PubSub;
    readonly extraDbs: { [name: string]: DB };
    readonly milestoneDb: MilestoneDB;
    readonly projections: { [collection: string]: any };

    use(action: string | string[], middleware: Middleware): void;
    connect(connection?: Connection, req?: any): Agent;
    listen(stream: any, req?: any): Agent;
    close(callback?: Callback): void;

    addProjection(name: string, collection: string, fields: any): void;
  }

  // ===============================
  // Client Types
  // ===============================

  interface ConnectionOptions {
    [key: string]: any;
  }

  interface Connection extends EventEmitter {
    readonly collections: { [collection: string]: { [id: string]: Doc } };
    readonly id: string;
    readonly state: 'connecting' | 'connected' | 'disconnected' | 'closed';
    readonly canSend: boolean;
    
    get(collection: string, id: string): Doc;
    getBulk(collection: string, ids: string[], callback: Callback<Doc[]>): void;
    createQuery(collection: string, query: any, options?: QueryOptions): Query;
    createSubscribeQuery(collection: string, query: any, options?: QueryOptions, callback?: Callback<Query>): Query;
    createFetchQuery(collection: string, query: any, options?: QueryOptions, callback?: Callback<Query>): Query;
    
    fetchSnapshot(collection: string, id: string, version?: number, callback?: Callback<Snapshot>): void;
    fetchSnapshotByTimestamp(collection: string, id: string, timestamp: number, callback?: Callback<Snapshot>): void;
    
    useDurableStore(durableStore: DurableStore): void;
    
    // DurableStore inventory methods
    isDocInInventory(collection: string, id: string, minVersion?: string | number): boolean;
    forEachPendingDocCollectionId(callback: (collection: string, id: string) => void): void;
    
    // Batch writing control
    setAutoFlush(enabled: boolean): void;
    isAutoFlush(): boolean;
    putDoc(doc: Doc, callback?: Callback): void;
    putDocs(docs: Doc[], callback?: Callback): void;
    putDocsBulk(docs: Doc[], callback?: Callback): void;
    flushWrites(callback?: Callback): void;
    getWriteQueueSize(): number;
    hasPendingWrites(): boolean;
    
    presence(channel: string): Presence;
    
    close(): void;
    
    // Events: 'connected', 'disconnected', 'closed', 'error', 'state'
  }

  interface DocOptions {
    [key: string]: any;
  }

  interface Doc extends EventEmitter {
    readonly collection: string;
    readonly id: string;
    readonly data: any;
    readonly version: number;
    readonly type: any;
    readonly subscribed: boolean;
    readonly hasWritePending: boolean;
    readonly inflightCreate: RawOp | null;
    readonly inflightDel: RawOp | null;
    readonly inflightOp: RawOp | null;
    readonly pendingOps: RawOp[];

    create(data: any, type?: string | any, options?: any, callback?: OpCallback): this;
    create(data: any, type?: string | any, callback?: OpCallback): this;
    create(data: any, callback?: OpCallback): this;

    submitOp(op: Op[], options?: any, callback?: OpCallback): this;
    submitOp(op: Op[], callback?: OpCallback): this;
    submitOp(op: Op, options?: any, callback?: OpCallback): this;
    submitOp(op: Op, callback?: OpCallback): this;

    del(options?: any, callback?: OpCallback): this;
    del(callback?: OpCallback): this;

    fetch(callback?: Callback): this;
    subscribe(callback?: Callback): this;
    unsubscribe(callback?: Callback): this;

    whenNothingPending(callback: Callback): void;
    
    // DurableStore-related methods
    destroy(callback?: Callback): void;
    ensureDocHasData(callback?: Callback): void;
    ensureDocHasRecentData(minVersion: string | number, callback?: Callback): void;

    // Events: 'load', 'create', 'before op', 'op', 'del', 'error', 'nothing pending'
  }

  interface QueryOptions {
    results?: any[];
    [key: string]: any;
  }

  interface Query extends EventEmitter {
    readonly collection: string;
    readonly query: any;
    readonly options: QueryOptions;
    readonly results: any[] | null;
    readonly ready: boolean;
    readonly subscribed: boolean;

    subscribe(callback?: Callback): this;
    unsubscribe(callback?: Callback): this;
    fetch(callback?: Callback): this;
    destroy(): void;

    // Events: 'ready', 'error', 'changed', 'insert', 'move', 'remove'
  }

  // ===============================
  // DurableStore Types  
  // ===============================

  interface DurableStoreOptions {
    maxBatchSize?: number;
    extVersionDecoder?: (data: any) => string | number;
    opErrorCallback?: (error: ShareDBError) => void;
    debug?: boolean;
  }

  // ===============================
  // Storage Types
  // ===============================

  type DurableStorageCallback<T = any> = (error: ShareDBError | null, result?: T) => void;

  interface DurableStorageRecord {
    id: string;
    payload: any;
  }

  interface DurableStorageRecords {
    docs?: DurableStorageRecord | DurableStorageRecord[];
    meta?: DurableStorageRecord | DurableStorageRecord[];
  }

  interface DurableStorage {
    initialize(callback: DurableStorageCallback): void;
    readRecord(storeName: string, id: string, callback: DurableStorageCallback<any>): void;
    readAllRecords(storeName: string, callback: DurableStorageCallback<DurableStorageRecord[]>): void;
    readRecordsBulk?(storeName: string, ids: string[], callback: DurableStorageCallback<DurableStorageRecord[]>): void;
    writeRecords(records: DurableStorageRecords, callback: DurableStorageCallback): void;
    deleteRecord(storeName: string, id: string, callback: DurableStorageCallback): void;
    clearStore(storeName: string, callback: DurableStorageCallback): void;
    clearAll(callback: DurableStorageCallback): void;
    close?(callback: DurableStorageCallback): void;
    isReady?(): boolean;
  }

  interface InMemoryStorageOptions {
    debug?: boolean;
  }

  interface InMemoryStorage extends DurableStorage {
    readonly ready: boolean;
    readonly stores: { [storeName: string]: { [id: string]: any } };
  }

  interface IndexedDbStorageOptions {
    namespace?: string;
    useEncryption?: boolean;
    encryptionCallback?: (text: string) => string;
    decryptionCallback?: (encrypted: string) => string;
    debug?: boolean;
    maxBatchSize?: number;
  }

  interface IndexedDbStorage extends DurableStorage {
    readonly namespace: string;
    readonly dbName: string;
    readonly useEncryption: boolean;
    readonly ready: boolean;
    readonly db: IDBDatabase;

    deleteDatabase(): void;
  }

  class DurableStore extends EventEmitter {
    readonly storage: DurableStorage;
    readonly maxBatchSize: number;
    readonly debug: boolean;

    constructor(storage: DurableStorage, options?: DurableStoreOptions);

    initialize(callback: DurableStorageCallback): void;
    persistDocuments(docs: Doc[], callback: DurableStorageCallback): void;
    retrieveDocuments(callback: DurableStorageCallback<any[]>): void;
    retrieveDocumentsBulk(collection: string, ids: string[], callback: DurableStorageCallback<any[]>): void;
    clearDocuments(callback: DurableStorageCallback): void;
    
    // Batch writing control
    putDocsBulk(docs: Doc[], callback?: DurableStorageCallback): void;
    flush(callback?: DurableStorageCallback): void;
    getWriteQueueSize(): number;
    setAutoBatchEnabled(enabled: boolean): void;
    isAutoBatchEnabled(): boolean;

    // Shutdown: once closed, incoming writes are dropped and the write loop stops
    close(): void;
    readonly closed: boolean;

    // Events: 'load', 'error', 'before persist', 'persist', 'no persist pending'
  }


  // ===============================
  // Static Constructors
  // ===============================

  interface BackendStatic {
    new (options?: BackendOptions): Backend;
    (options?: BackendOptions): Backend;
  }

  interface ConnectionStatic {
    new (socket: any, options?: ConnectionOptions): Connection;
  }

  interface DocStatic {
    new (connection: Connection, collection: string, id: string, options?: DocOptions): Doc;
  }

  interface QueryStatic {
    new (connection: Connection, collection: string, query: any, options?: QueryOptions): Query;
  }


  interface InMemoryStorageStatic {
    new (options?: InMemoryStorageOptions): InMemoryStorage;
  }

  interface IndexedDbStorageStatic {
    new (options?: IndexedDbStorageOptions): IndexedDbStorage;
  }


  // ===============================
  // SharedWorker Proxy System
  // ===============================

  interface ProxyCapabilities {
    hasSharedWorker: boolean;
    hasBroadcastChannel: boolean;
    hasIndexedDB: boolean;
    canUseProxy: boolean;
    userAgent: string;
  }

  interface MessageBrokerOptions {
    channelName?: string;
    debug?: boolean;
  }

  interface MessageBrokerStats {
    tabId: string;
    isReady: boolean;
    queuedMessages: number;
    pendingCallbacks: number;
    channelName: string;
  }

  interface MessageBroker extends EventEmitter {
    readonly tabId: string;
    readonly channelName: string;
    readonly debug: boolean;

    send(message: any, callback?: Callback): void;
    isReady(): boolean;
    getStats(): MessageBrokerStats;
    close(): void;
    startCleanupTimer(interval?: number): void;
    stopCleanupTimer(): void;
  }

  interface MessageBrokerStatic {
    new (options?: MessageBrokerOptions): MessageBroker;
  }

  interface ProxyConnectionOptions {
    channelName?: string;
    debug?: boolean;
    storage?: DurableStorage;
    durableStoreOptions?: DurableStoreOptions;
  }

  interface ProxyConnectionStats {
    id: string;
    state: string;
    canSend: boolean;
    cachedDocuments: number;
    messageBroker: MessageBrokerStats;
  }

  interface ProxyConnection extends EventEmitter {
    readonly id: string;
    readonly state: string;
    readonly canSend: boolean;
    readonly collections: { [collection: string]: { [id: string]: ProxyDoc } };

    // Document methods
    get(collection: string, id: string): ProxyDoc;
    getExisting(collection: string, id: string): ProxyDoc | undefined;
    getBulk(collection: string, ids: string[], callback: Callback<ProxyDoc[]>): void;

    // Batch writing control
    setAutoFlush(enabled: boolean): void;
    isAutoFlush(): boolean;
    putDoc(doc: ProxyDoc, callback?: Callback): void;
    putDocs(docs: ProxyDoc[], callback?: Callback): void;
    putDocsBulk(docs: ProxyDoc[], callback?: Callback): void;
    flushWrites(callback?: Callback): void;
    getWriteQueueSize(): number;
    hasPendingWrites(): boolean;

    // Query methods (not yet implemented in proxy)
    createQuery(collection: string, query: any, options?: QueryOptions): never;
    createSubscribeQuery(collection: string, query: any, options?: QueryOptions, callback?: Callback<Query>): never;
    createFetchQuery(collection: string, query: any, options?: QueryOptions, callback?: Callback<Query>): never;

    // Presence methods (not yet implemented in proxy)
    presence(channel: string): never;

    // Statistics and debugging
    getStats(): ProxyConnectionStats;
    close(): void;
  }

  interface ProxyConnectionStatic {
    new (options?: ProxyConnectionOptions): ProxyConnection;
  }

  interface ProxyDocStats {
    collection: string;
    id: string;
    version: number | null;
    type: string | null;
    subscribed: boolean;
    wantSubscribe: boolean;
    hasPendingOps: boolean;
    pendingOpsCount: number;
    syncedWithSharedWorker: boolean;
  }

  interface ProxyDoc extends EventEmitter {
    readonly connection: ProxyConnection;
    readonly collection: string;
    readonly id: string;
    version: number | null;
    type: string | null;
    data: any;
    subscribed: boolean;

    // Subscription methods
    subscribe(callback?: Callback): void;
    unsubscribe(callback?: Callback): void;
    fetch(callback?: Callback): void;

    // Document operations
    create(data: any, type?: string, options?: any, callback?: Callback): void;
    submitOp(op: Op, source?: any, callback?: Callback): void;
    del(source?: any, callback?: Callback): void;

    // State methods
    hasPendingOps(): boolean;
    exists(): boolean;
    getSnapshot(): { id: string; v: number | null; type: string | null; data: any };
    clone(): any;
    getKey(): string;

    // Utility methods
    flush(callback?: Callback): void;
    pause(): void;
    resume(): void;
    getStats(): ProxyDocStats;
    destroy(): void;
  }

  interface ProxyDocStatic {
    new (connection: ProxyConnection, collection: string, id: string): ProxyDoc;
  }

  interface SharedWorkerManagerOptions {
    debug?: boolean;
    channelName?: string;
    storage?: DurableStorage;
    durableStoreOptions?: DurableStoreOptions;
    sharedWorkerPath?: string;
  }

  interface SharedWorkerManagerStats {
    activeTabs: number;
    documentSubscriptions: number;
    connectionState: string;
    durableStoreReady: boolean;
  }

  interface SharedWorkerManager {
    readonly debug: boolean;
    readonly channelName: string;

    getStats(): SharedWorkerManagerStats;
  }

  interface SharedWorkerManagerStatic {
    new (options?: SharedWorkerManagerOptions): SharedWorkerManager;
  }

  interface ConnectionFactoryOptions extends ProxyConnectionOptions {
    useSharedWorker?: boolean;
    forceProxy?: boolean;
    forceDirect?: boolean;
    sharedWorkerPath?: string;
  }

  interface ConnectionFactory {
    createConnection(backendOrSocket?: any, options?: ConnectionFactoryOptions): Connection | ProxyConnection;
    createConnectionWithStorage(backendOrSocket: any, storage: DurableStorage, options?: ConnectionFactoryOptions): Connection | ProxyConnection;
    isProxyConnection(connection: any): connection is ProxyConnection;
    getProxyCapabilities(): ProxyCapabilities;
    getConnectionStats(): { capabilities: ProxyCapabilities; timestamp: string };
    createSharedWorkerScript(options?: { sharedbPath?: string; debug?: boolean; channelName?: string }): string;

    // Convenience methods
    create(backendOrSocket?: any, options?: ConnectionFactoryOptions): Connection | ProxyConnection;
    withStorage(backendOrSocket: any, storage: DurableStorage, options?: ConnectionFactoryOptions): Connection | ProxyConnection;
  }

  interface ProxySystem {
    ConnectionFactory: ConnectionFactory;
    ProxyConnection: ProxyConnectionStatic;
    ProxyDoc: ProxyDocStatic;
    MessageBroker: MessageBrokerStatic;
    SharedWorkerManager: SharedWorkerManagerStatic;

    // Convenience methods
    createConnection(backendOrSocket?: any, options?: ConnectionFactoryOptions): Connection | ProxyConnection;
    createConnectionWithStorage(backendOrSocket: any, storage: DurableStorage, options?: ConnectionFactoryOptions): Connection | ProxyConnection;
    isProxyConnection(connection: any): connection is ProxyConnection;
    getProxyCapabilities(): ProxyCapabilities;
    hasProxySupport(): boolean;
    connect(backendOrSocket?: any, options?: ConnectionFactoryOptions): Connection | ProxyConnection;
    connectWithStorage(backendOrSocket: any, storage: DurableStorage, options?: ConnectionFactoryOptions): Connection | ProxyConnection;
  }

  // Static constructors for proxy system
  interface ProxyConnectionStatic {
    new (options?: ProxyConnectionOptions): ProxyConnection;
  }

  interface ProxyDocStatic {
    new (connection: ProxyConnection, collection: string, id: string): ProxyDoc;
  }

  interface MessageBrokerStatic {
    new (options?: MessageBrokerOptions): MessageBroker;
  }

  interface SharedWorkerManagerStatic {
    new (options?: SharedWorkerManagerOptions): SharedWorkerManager;
  }
}

// ===============================
// Main ShareDB Module Declaration
// ===============================

declare class ShareDB {
  constructor(options?: ShareDB.BackendOptions);

  static Agent: any;
  static Backend: ShareDB.BackendStatic;
  static DB: any;
  static Error: any;
  static logger: any;
  static MemoryDB: any;
  static MemoryMilestoneDB: any;
  static MemoryPubSub: any;
  static MESSAGE_ACTIONS: any;
  static MilestoneDB: any;
  static ot: any;
  static projections: any;
  static PubSub: any;
  static QueryEmitter: any;
  static SubmitRequest: any;
  static types: ShareDB.TypesModule;
}

declare namespace ShareDB {
  export const Connection: ConnectionStatic;
  export const Doc: DocStatic; 
  export const Query: QueryStatic;
  
  // DurableStore System
  
  // SharedWorker Proxy System
  export const proxy: ProxySystem;
  export const ProxyConnection: ProxyConnectionStatic;
  export const ProxyDoc: ProxyDocStatic;
  export const MessageBroker: MessageBrokerStatic;
  export const SharedWorkerManager: SharedWorkerManagerStatic;
  export const ConnectionFactory: ConnectionFactory;
}

export = ShareDB;