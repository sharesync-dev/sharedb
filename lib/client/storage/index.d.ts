// Type definitions for ShareDB Storage Systems
// Project: https://github.com/share/sharedb
// Definitions by: Claude Code <https://claude.ai/code>

import { EventEmitter } from 'events';

// Import main ShareDB types for OT operations
import { ShareDBError, Op, Json0Op, RichTextOp, TextOp, OTType } from '../../index';

// ===============================
// DurableStorage - Core Storage Interface
// ===============================

export type DurableStorageCallback<T = any> = (error: ShareDBError | null, result?: T) => void;

export interface DurableStorageRecord {
  id: string;
  payload: any;
}

export interface DurableStorageRecords {
  docs?: DurableStorageRecord | DurableStorageRecord[];
  meta?: DurableStorageRecord | DurableStorageRecord[];
}

export interface DurableStorage {
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

// ===============================
// DurableStore - Document Persistence Layer
// ===============================

export interface DurableStoreOptions {
  maxBatchSize?: number;
  extVersionDecoder?: (data: any) => string | number;
  opErrorCallback?: (error: ShareDBError) => void;
  debug?: boolean;
}

export class DurableStore extends EventEmitter {
  readonly storage: DurableStorage;
  readonly maxBatchSize: number;
  readonly debug: boolean;

  constructor(storage: DurableStorage, options?: DurableStoreOptions);

  initialize(callback: DurableStorageCallback): void;
  persistDocuments(docs: any[], callback: DurableStorageCallback): void;
  retrieveDocuments(callback: DurableStorageCallback<any[]>): void;
  retrieveDocumentsBulk(collection: string, ids: string[], callback: DurableStorageCallback<any[]>): void;
  clearDocuments(callback: DurableStorageCallback): void;
  
  // Batch writing control
  putDocsBulk(docs: any[], callback?: DurableStorageCallback): void;
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
// In-Memory Storage
// ===============================

export interface InMemoryStorageOptions {
    debug?: boolean;
  }

interface InMemoryStorage extends DurableStorage {
  readonly ready: boolean;
  readonly stores: { [storeName: string]: { [id: string]: any } };
}

interface InMemoryStorageStatic {
  new (options?: InMemoryStorageOptions): InMemoryStorage;
}

// ===============================
// IndexedDB Storage
// ===============================

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

interface IndexedDbStorageStatic {
  new (options: IndexedDbStorageOptions): IndexedDbStorage;
}


// ===============================
// Implementation Exports
// ===============================

export const InMemoryStorage: InMemoryStorageStatic;
export const IndexedDbStorage: IndexedDbStorageStatic;