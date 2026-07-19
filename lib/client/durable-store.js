var emitter = require('../emitter');
var logger = require('../logger');
var ShareDBError = require('../error');

var ERROR_CODE = ShareDBError.CODES;

var DEFAULT_MAX_BATCH_SIZE = 10;

/**
 * Sets up a durable store, so that ShareDB state can be persisted offline across
 * multible browser sessions.
 *
 * Rather than trying to persist offline state only when the browser (or app) shuts down,
 * or when the page unloads, we persist offline state continuously to the DurableStore.
 *
 * This is an 'offline-first' approach, which assumes that going offline is a normal
 * part of the application lifecycle, so we always write operations to the durable
 * store before sending them to the server.
 *
 * @param storage A storage engine instance (e.g., IndexedDbStorage, SqliteStorage, InMemoryStorage)
 * @param options A map of options that can be used to configure the durable store
 *
 * options.maxBatchSize (integer, optional): Sets the maximum number of items written
 * during each storage insertion batch.
 *
 * options.extVersionDecoder (function returning string or number, optional): Called on each
 * doc record's 'data' object, before insertion into the durable store, to determine the
 * version that should be recorded in the inventory. By default, we use the native 'doc.version'
 * from ShareDB, but an application can supply its own "version-decoder" function to return
 * an app-specific version number or string.
 *
 * options.opErrorCallback (void function, optional): Certain OT operations emit conflicts.
 * This callback allows the application handle those conflicts (e.g., log a message, throw
 * an error, ignore it, etc). If a callback is not supplied here, the durable store will use
 * its own default (empty) callback, which will ignore all conflicts.
 *
 * options.debug (boolean, optional): Determines whether logging messages should be emitted.
 */
module.exports = DurableStore;
function DurableStore(storage, options) {
  emitter.EventEmitter.call(this);
  if (!storage) {
    throw new Error('storage engine is required for DurableStore');
  }
  this.storage = storage;
  options = options || {};
  this.maxBatchSize = options.maxBatchSize || DEFAULT_MAX_BATCH_SIZE;
  this.docQueueItems = [];
  this.extVersionDecoder = options.extVersionDecoder || null;
  this.opErrorCallback = options.opErrorCallback || function(err) {};
  this.debug = options.debug || false;
  this.busy = false;
  this.closed = false;
  this._autoBatchEnabled = true;
}
emitter.mixin(DurableStore);

/**
 * Initializes the underlying storage.
 */
DurableStore.prototype.initialize = function(callback) {
  var self = this;
  this.storage.initialize(function(error, inventory) {
    if (error) {
      console.error('DurableStore: Storage initialization failed:', error);
      callback && callback(error);
      return;
    }
    self._onReady(inventory);
    callback && callback();
  });
};

DurableStore.prototype._onReady = function(inventory) {
  this.inventory = inventory;
  this.ready = true;
  this.emit('ready');
};

/**
 * Closes the DurableStore to further writes. Called during application shutdown,
 * after a final flush(), and before the underlying storage is disconnected.
 *
 * Once closed, putDoc() drops incoming writes (invoking their callbacks with null)
 * instead of queueing them, and the batch write loop stops. This prevents late
 * writes -- e.g. docs persisting state as the connection tears down -- from racing
 * against the storage close and erroring on a dead database handle.
 */
DurableStore.prototype.close = function() {
  if (this.closed) return;
  this.closed = true;

  // Drop anything still queued; their writes will never run. Invoke their
  // callbacks with null (not an error) -- at shutdown this is intentional
  // discard, and the data re-syncs from the server next session.
  var droppedItems = this.docQueueItems;
  this.docQueueItems = [];
  if (droppedItems.length > 0) {
    logger.info('DurableStore: dropped ' + droppedItems.length + ' queued write(s) on close');
  }
  for (var i = 0; i < droppedItems.length; i++) {
    droppedItems[i].callback && droppedItems[i].callback(null);
  }

  // Resolve any pending flush callbacks so callers awaiting a flush don't hang.
  if (this.flushCallbacks && this.flushCallbacks.length > 0) {
    var callbacks = this.flushCallbacks;
    this.flushCallbacks = [];
    for (var j = 0; j < callbacks.length; j++) {
      callbacks[j](null);
    }
  }
};

/**
 * Puts a doc into the DurableStore
 */
DurableStore.prototype.putDoc = function(doc, callback) {
  if (this.closed) {
    this.log('Dropping write for doc (' + doc.collection + '/' + doc.id + ') after close');
    callback && callback(null);
    return;
  }
  this.storage.ensureReady();

  var docRecord = this.makeDocRecord(doc);

  var now = (typeof window !== 'undefined' && window.performance) 
    ? window.performance.now()
    : Date.now();
  
  // When auto-batching is disabled, call callback immediately after queuing
  // The actual write will happen when flush() is called
  var immediateCallback = (this._autoBatchEnabled === false && callback);
  
  this.docQueueItems.push({
    record: docRecord,
    queue_time: now,
    callback: immediateCallback ? null : callback  // Don't store callback if calling immediately
  });

  if (!this.busy && this._autoBatchEnabled !== false) {
    this._putNextBatchFromQueue();
  }
  
  // Call callback immediately if auto-batching is disabled
  if (immediateCallback) {
    immediateCallback(null);
  }
};

DurableStore.prototype.makeDocRecord = function(doc) {
  // Only store the "truthiness" of pendingOps' source property
  var storedPendingOps = doc.pendingOps.map(function(op) {
    return Object.assign({}, op, {source: !!op.source});
  });

  // Clone the inflightOp and also store only its "truthiness" in the source property
  var storedInflightOp = doc.inflightOp ?
    Object.assign({}, doc.inflightOp, {source: !!doc.inflightOp.source}) :
    null;

  // HACK! The persisted inflightOp should always have the src set.  The
  // inflightOp only has a null src the first time it is sent.  If a doc is
  // ever restored with an inflightOp, then the doc will definitely resubmit
  // the op with a new connection id (src), but we want to preserve the
  // original connection id that is about to be assigned to the src property of
  // the inflightOp once it is sent to the server.
  if (storedInflightOp && storedInflightOp.src == null) {
    storedInflightOp.src = doc.connection.id;
  }

  var docRecord = {
    id: doc.collection + '/' + doc.id,
    payload: {
      collection: doc.collection,
      id: doc.id,
      type_name: (doc.type && doc.type.name) ? doc.type.name : null,
      version: doc.version,
      data: doc.data,
      pendingOps: JSON.parse(JSON.stringify(storedPendingOps)),
      inflightOp: JSON.parse(JSON.stringify(storedInflightOp)),
      preventCompose: doc.preventCompose,
      submitSource: doc.submitSource
    }
  };

  return docRecord;
}

/**
 * Consumes doc records from the queue, prepares a batch for writing to IndexedDb, and
 * executes all their callbacks (in order) when the batch completes.
 */
DurableStore.prototype._putNextBatchFromQueue = function() {
  if (this.closed || !this.ready || this.busy || !this.hasDocsInWriteQueue()) {
    return;
  }
  this.busy = true;

  // Accumulate records into a batch by consuming from the queue. If we already have another record
  // in the batch with the same ID, then put this record back where we found it, and close the batch.
  var keysInBatch = {};
  var docQueueItemsInBatch = [];
  var docRecordsInBatch = [];
  while (this.docQueueItems.length > 0 && docRecordsInBatch.length < this.maxBatchSize) {
    var docQueueItem = this.docQueueItems.shift();
    var docRecord = docQueueItem.record;
    if (keysInBatch[docRecord.id]) {
      this.docQueueItems.unshift(docQueueItem);
      break;
    }
    docQueueItemsInBatch.push(docQueueItem);
    docRecordsInBatch.push(docRecord);
    keysInBatch[docRecord.id] = true;
  }

  // First pass: validate all versions before making any changes
  var versionError = null;
  var inventoryUpdates = [];
  
  for (var i = 0; i < docRecordsInBatch.length; i++) {
    var docRecord = docRecordsInBatch[i];
    var collection = docRecord.payload.collection;
    var id = docRecord.payload.id;
    var hasInflightOp = !!docRecord.payload.inflightOp;
    var hasPendingOps = docRecord.payload.pendingOps && docRecord.payload.pendingOps.length > 0;
    
    // Generate a version identifier to store in the inventory
    var docVersion = this.makeInventoryVersion(docRecord);
    
    // Check for version regression and type consistency
    if (!this.inventory.payload.collections.hasOwnProperty(collection)) {
      this.inventory.payload.collections[collection] = {};
    }
    
    // A type-null record represents a DELETED doc. Its data is undefined, so
    // with an extVersionDecoder configured makeInventoryVersion yields null,
    // which can never pass the type/regression checks against a real prior
    // version — the deletion write would be rejected (and, when enqueued
    // without a callback, rejected silently), leaving the stale record
    // restorable forever. Deletions supersede any prior version, so skip the
    // version checks for them; the inventory entry keeps v: null, which
    // hasMinVersion treats as older-than-everything (forcing a server fetch
    // for any versioned read, which correctly re-observes the deletion).
    var isDeletionRecord = docRecord.payload.type_name === null && docRecord.payload.data === undefined;

    var existingEntry = this.inventory.payload.collections[collection][id];
    if (existingEntry && existingEntry.v != null && !isDeletionRecord) {
      var oldVersion = existingEntry.v;
      
      // Check for version type mismatch
      if (typeof oldVersion !== typeof docVersion) {
        versionError = new Error(
          'Version type mismatch: Cannot store ' + collection + '/' + id + 
          ' with ' + typeof docVersion + ' version ' + docVersion + 
          ' when existing version is ' + typeof oldVersion + ' ' + oldVersion + 
          ' (version type must remain consistent)'
        );
        break;
      }
      
      // Check for version regression
      // hasMinVersion checks if testVersion >= minVersion
      // We want to check if docVersion >= oldVersion
      if (!this.hasMinVersion(oldVersion, docVersion)) {
        versionError = new Error(
          'Version regression detected: Cannot store ' + collection + '/' + id + 
          ' with version ' + docVersion + ' when version ' + oldVersion + 
          ' already exists (versions must increase or remain the same)'
        );
        break;
      }
    }
    
    // Store the update to apply later if all validations pass
    inventoryUpdates.push({
      collection: collection,
      id: id,
      entry: {
        p: hasInflightOp || hasPendingOps,
        v: docVersion
      }
    });
  }
  
  // If there was a version error, call callbacks with the error and return early
  if (versionError) {
    for (var i = 0; i < docQueueItemsInBatch.length; i++) {
      var docQueueItem = docQueueItemsInBatch[i];
      docQueueItem.callback && docQueueItem.callback(versionError);
    }
    this.busy = false;
    // Don't put items back in queue - they failed validation
    // If there are new items in the queue, process them
    if (this.hasDocsInWriteQueue()) {
      this._putNextBatchFromQueue();
    }
    return;
  }
  
  // Second pass: apply all inventory updates (all validations passed)
  for (var i = 0; i < inventoryUpdates.length; i++) {
    var update = inventoryUpdates[i];
    if (!this.inventory.payload.collections.hasOwnProperty(update.collection)) {
      this.inventory.payload.collections[update.collection] = {};
    }
    this.inventory.payload.collections[update.collection][update.id] = update.entry;
  }

  // Write the actual records, and upon completion, execute all their callbacks.
  var durableStore = this;
  durableStore.emit('before persist', {docs: docRecordsInBatch});
  durableStore.storage.writeRecords(
    {
      meta: durableStore.inventory,
      docs: docRecordsInBatch
    },
    function(error) {
      durableStore.emit('persist', {docs: docRecordsInBatch});
      var now = (typeof window !== 'undefined' && window.performance)
        ? window.performance.now()
        : Date.now();
      for (var i = 0; i < docQueueItemsInBatch.length; i++) {
        var docQueueItem = docQueueItemsInBatch[i];
        var docCompoundKey = docQueueItem.record.id;
        var duration = now - docQueueItem.queue_time;
        durableStore.log('Wrote doc (' + docCompoundKey + ') in ' + duration + ' millis');
        docQueueItem.callback && docQueueItem.callback(error || null);
      }
      durableStore.busy = false;
      // If there are new items in the queue, process another batch.
      // Otherwise, emit a 'no persist pending' event and call flush callbacks
      if (durableStore.hasDocsInWriteQueue()) {
        durableStore._putNextBatchFromQueue();
      } else {
        durableStore.emit('no persist pending');
        // Call any pending flush callbacks
        if (durableStore.flushCallbacks && durableStore.flushCallbacks.length > 0) {
          var callbacks = durableStore.flushCallbacks;
          durableStore.flushCallbacks = [];
          for (var j = 0; j < callbacks.length; j++) {
            callbacks[j](error || null);
          }
        }
      }
    }
  );
};

/**
 * Retrieves a doc object from the DurableStore.
 */
DurableStore.prototype.getDoc = function(collection, id, callback) {
  var compoundKey = collection + '/' + id;
  this.storage.readRecord('docs', compoundKey, function(error, record) {
    callback(error, record);
  });
};

/**
 * Gets multiple doc objects from the DurableStore in a single batch operation.
 * This method leverages the storage layer's bulk capabilities for efficiency.
 * 
 * @param {string} collection - Collection name
 * @param {string[]} ids - Array of document IDs to retrieve
 * @param {function} callback - Callback function (error, docDatas)
 */
DurableStore.prototype.getDocsBulk = function(collection, ids, callback) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return callback(null, []);
  }
  
  var storeName = 'docs';
  
  // Check if storage supports bulk operations
  if (this.storage.readRecordsBulk) {
    // Generate compound keys for all requested documents
    var compoundKeys = [];
    for (var i = 0; i < ids.length; i++) {
      compoundKeys.push(collection + '/' + ids[i]);
    }
    
    // Use storage bulk method
    this.storage.readRecordsBulk(storeName, compoundKeys, function(error, records) {
      if (error) return callback(error);

      // Transform storage records into doc data format
      var docDatas = [];
      if (records && records.length > 0) {
        for (var j = 0; j < records.length; j++) {
          var record = records[j];
          if (record && record.payload) {
            docDatas.push({
              id: record.payload.id,
              data: record.payload.data,
              v: record.payload.v,
              type: record.payload.type
            });
          }
        }
      }

      callback(null, docDatas);
    });
  } else {
    // Fallback to individual getDoc calls for storage implementations 
    // that don't support bulk operations
    var docDatas = [];
    var remaining = ids.length;
    var hasError = false;
    
    if (remaining === 0) {
      return callback(null, []);
    }
    
    for (var k = 0; k < ids.length; k++) {
      (function(id) {
        this.getDoc(collection, id, function(error, docData) {
          if (hasError) return;

          if (error) {
            hasError = true;
            return callback(error);
          }

          if (docData) {
            docDatas.push(docData);
          }

          remaining--;
          if (remaining === 0) {
            callback(null, docDatas);
          }
        });
      }.bind(this))(ids[k]);
    }
  }
};

// Backward compatibility alias for the old verbose name
DurableStore.prototype.retrieveDocumentsBulk = DurableStore.prototype.getDocsBulk;

/**
 * Retrieves the 'inventory' object from the 'meta' object-store. This object persists
 * a map of all collections -- and all docs within those collections -- whose data is persisted
 * in the DurableStore. For each collection/id pair, there is an object with the version
 * number of the current local snapshot, and a boolean flag indicating whether any pending
 * operations are in the DurableStore, waiting to be pushed to the server when the connection
 * is reinstated.
 *
 * {
 *   'id': 'inventory',
 *   'payload' : {
 *     'collections': {
 *       'foo': {
 *         'bar': {'v': 123, 'p': true },
 *         'baz': {'v': 456, 'p': false }
 *       },
 *       'zip': {
 *         'zap': {'v': 789, 'p': false },
 *         'zop': {'v': 1011, 'p': true }
 *       }
 *     }
 *   }
 * }
 *
 * NOTE: By default, the 'v' version numbers are taken from the 'doc' objects. However, if the user
 * provided an 'extVersionDecoder' function, then we'll apply that function to each 'doc.data' and
 * use the return value as the 'v' version instead.
 *
 * The 'inventory' object is a singleton, and always has an 'id' of 'inventory '.
 */
DurableStore.prototype.getInventoryMeta = function(callback) {
  this.storage.readRecord('meta', 'inventory', function(error, record) {
    callback(error, record);
  });
};

/**
 * A convenience function that returns true if there are any queued writes to IndexedDb waiting to be executed.
 */
DurableStore.prototype.hasDocsInWriteQueue = function() {
  return this.docQueueItems.length > 0;
};

/**
 * Get the current size of the write queue
 */
DurableStore.prototype.getWriteQueueSize = function() {
  return this.docQueueItems.length;
};

/**
 * Get current auto-batch setting
 */
DurableStore.prototype.isAutoBatchEnabled = function() {
  return this._autoBatchEnabled;
};

/**
 * Set auto-batch enabled/disabled
 */
DurableStore.prototype.setAutoBatchEnabled = function(enabled) {
  var wasEnabled = this._autoBatchEnabled;
  this._autoBatchEnabled = enabled;
  
  // If re-enabling auto-batching and there are queued items, process them
  if (!wasEnabled && enabled && this.docQueueItems.length > 0 && !this.busy) {
    this._putNextBatchFromQueue();
  }
  
  return wasEnabled;
};

/**
 * Flush any pending writes to storage
 */
DurableStore.prototype.flush = function(callback) {
  if (this.docQueueItems.length === 0) {
    return callback && callback(null);
  }
  
  // Temporarily store callback to be called after batch completes
  if (callback) {
    this.flushCallbacks = this.flushCallbacks || [];
    this.flushCallbacks.push(callback);
  }
  
  // Execute pending queue items
  if (!this.busy) {
    this._putNextBatchFromQueue();
  }
};

/**
 * Put multiple documents in bulk
 */
DurableStore.prototype.putDocsBulk = function(docs, callback) {
  if (!docs || !Array.isArray(docs) || docs.length === 0) {
    return callback && callback(null);
  }
  
  var self = this;
  var originalAutoBatch = this._autoBatchEnabled;
  var errors = [];
  var completed = 0;
  
  // Disable auto-batching during bulk operation
  this._autoBatchEnabled = false;
  
  // Queue all documents using putDoc to handle errors properly
  for (var i = 0; i < docs.length; i++) {
    (function(doc) {
      self.putDoc(doc, function(err) {
        if (err) errors.push(err);
        completed++;
        
        if (completed === docs.length) {
          // Restore original auto-batch setting
          self._autoBatchEnabled = originalAutoBatch;
          
          // If there were errors, return the first one
          if (errors.length > 0) {
            return callback(errors[0]);
          }
          
          // Flush the queue
          self.flush(callback);
        }
      });
    })(docs[i]);
  }
};

/**
 * A convenience function that returns true if the offline inventory contains any docs with pending ops.
 */
DurableStore.prototype.hasPendingDocs = function() {
  this.storage.ensureReady();
  var collections = Object.keys(this.inventory.payload.collections);
  for (i = 0; i < collections.length; i++) {
    var collection = collections[i];
    var ids = Object.keys(this.inventory.payload.collections[collection]);
    for (j = 0; j < ids.length; j++) {
      var id = ids[j];
      var hasPendingOps = this.inventory.payload.collections[collection][id].p;
      if (hasPendingOps) {
        return true;
      }
    }
  }
  return false;
};

/**
 * Retrieves all docs with pending ops from the DurableStore, and calls the designated callback on them.
 */
DurableStore.prototype.loadEachPendingDocAndThen = function(callback) {
  this.storage.ensureReady();
  var durableStore = this;
  this.forEachPendingDocCollectionId(function(collection, id) {
    durableStore.getDoc(collection, id, callback);
  });
};

/**
 * Iterates through all items in the inventory, and for any doc with pending ops,
 * calls the callback with the doc's collection and id.
 */
DurableStore.prototype.forEachPendingDocCollectionId = function(callback) {
  this.storage.ensureReady();
  var collections = Object.keys(this.inventory.payload.collections);
  for (var i = 0; i < collections.length; i++) {
    var collection = collections[i];
    var ids = Object.keys(this.inventory.payload.collections[collection]);
    for (j = 0; j < ids.length; j++) {
      var id = ids[j];
      var hasPendingOps = this.inventory.payload.collections[collection][id].p;
      if (hasPendingOps) {
        callback(collection, id);
      }
    }
  }
};

/**
 * Returns true if there is an entry in the inventory for the given collection and id, indicating that
 * the doc has been persisted in the DurableStore. Optionally, if a 'minVersion' argument is provided,
 * this function returns true if the version in the inventory is GTE the supplied 'minVersion', which
 * can be either a number or a string, depending on the 'extVersionDecoder' function provided to the
 * DurableStore constructor.
 */
DurableStore.prototype.isDocInInventory = function(collection, id, minVersion) {
  if (
    this.inventory &&
    this.inventory.payload &&
    this.inventory.payload.collections &&
    this.inventory.payload.collections.hasOwnProperty(collection) &&
    this.inventory.payload.collections[collection].hasOwnProperty(id)
  ) {
    var inventoryVersion = this.inventory.payload.collections[collection][id].v;
    return this.hasMinVersion(minVersion, inventoryVersion);
  }
  return false;
};

DurableStore.prototype.hasMinVersion = function(minVersion, testVersion) {
  // If the requested 'minVersion' is undefined, then we don't need to check the recorded 'testVersion'. Return
  // true without comparing versions, because the record is definitely in the inventory. Otherwise, if the requested
  // 'minVersion' is a string or number, use an appropriate comparison to check it against the 'testVersion'.
  if (minVersion == null || typeof(minVersion) === 'undefined') {
    return true;
  }
  // NOTE: A null 'testVersion' is only written when the 'extVersionDecoder' function observes an 'undefined'
  // value for the 'doc.data' field. This happens upon doc construction, but before the 'create' op has been applied.
  // Therefore, a null 'testVersion' is considered implicitly less than any non-null 'minVersion'.
  if (testVersion == null || typeof(testVersion) === 'undefined') {
    return false;
  }
  // Perform a string comparison of the 'minVersion' and 'testVersion'
  if (typeof(minVersion) == 'string') {
    var comparison = 0;
    if (typeof(testVersion) == 'string') {
      comparison = testVersion.localeCompare(minVersion);
    } else {
      var testVersionString = '' + testVersion;
      comparison = testVersionString.localeCompare(minVersion);
    }
    return comparison >= 0;
  }
  // Perform a numeric comparison of the 'minVersion' and 'inventoryVersion'
  if (typeof(minVersion) == 'number') {
    if (typeof(testVersion) == 'number') {
      return testVersion >= minVersion;
    } else {
      var testVersionNumber = Number.parseFloat(inventoryVersion);
      return testVersionNumber >= minVersion;
    }
  }
  return false;
};

/**
 * This function accepts a 'docRecord' before immediately writing it to the DurableStore, and returns a
 * 'version' value that can be recorded in the 'v' field of the corresponding inventory record. By default,
 * the resultant version value is taken directly from the ShareDB 'doc.version' field. But if the user
 * provided an 'extVersionDecoder' function in the constructor of this DurableStore, then we'll use the
 * value returned by that function instead.
*/
DurableStore.prototype.makeInventoryVersion = function(docRecord) {
  if (!docRecord || !docRecord.payload) {
    return null;
  }
  if (this.extVersionDecoder) {
    if (docRecord.payload.data) {
      return this.extVersionDecoder(docRecord.payload.data);
    }
    return null;
  }
  return docRecord.payload.version;
};

DurableStore.prototype.restoreDocFromDurableRecord = function(doc, callback) {
  var durableStore = this;

  this.getDoc(doc.collection, doc.id, function(error, durableRecord) {
    if (error) {
      callback && callback(error);
      return;
    }

    // This restore path is only entered when the in-memory inventory says the
    // doc is present, so an empty record read means the store is inconsistent
    // (torn write, disrupted connection). Passing a bare success through here
    // would leave the doc un-hydrated (type=null), which upstream code reads
    // as "does not exist" and may respond to by re-creating a doc that exists
    // on the server (rejected with ERR_DOC_ALREADY_CREATED). Recover with a
    // server fetch when the connection allows; otherwise fail loudly.
    if (!durableRecord) {
      durableStore.log('Inventory lists doc (' + doc.collection + '/' + doc.id +
        ') but record read returned empty; ' +
        (doc.connection && doc.connection.canSend ? 'refetching from server' : 'no connection to refetch'));
      if (doc.connection && doc.connection.canSend) {
        doc.fetch(callback);
        return;
      }
      callback && callback(new ShareDBError(
        ERROR_CODE.ERR_DOC_MISSING_FROM_DURABLE_STORE,
        'Doc ' + doc.collection + '/' + doc.id + ' is in the inventory but its durable record is missing'
      ));
      return;
    }

    doc.collection = durableRecord.collection;
    doc.id = durableRecord.id;
    doc.version = durableRecord.version;
    doc._setData(durableRecord.data);
    doc.preventCompose = durableRecord.preventCompose;
    doc.submitSource = durableRecord.submitSource;

    // The durableRecord contains a only the type name, but we need the actual
    // type-object (with all of its member functions) in order to fully restore the doc.
    doc._setType(durableRecord.type_name);

    // We will need to set the error callback on all the ops
    var opErrorCallback = durableStore.opErrorCallback;

    // Then, we need to insert that full type object into any pendingOps contained in this doc.
    doc.pendingOps = durableRecord.pendingOps;
    
    for (var i = 0; i < doc.pendingOps.length; i++) {
      var pendingOp = doc.pendingOps[i];
      pendingOp.type = doc.type;
      pendingOp.callbacks = [ opErrorCallback ];
    }

    // If there was an inflightOp, we need to add it back to the front of the pendingOps queue
    var inflightOp = durableRecord.inflightOp;
    if (inflightOp) {
      inflightOp.type = doc.type;
      inflightOp.callbacks = [ opErrorCallback ];
      doc.pendingOps.unshift(inflightOp);
    }

    doc.emit('restore');

    callback && callback();
  });
};

DurableStore.prototype.log = function(message) {
  this.debug && logger.info('DurableStore: ' + message);
};

DurableStore.prototype.deleteDatabase = function() {
  this.storage.deleteDatabase();
};