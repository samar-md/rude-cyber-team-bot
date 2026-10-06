const { MongoClient } = require('mongodb');
const {
  BufferJSON,
  initAuthCreds,
  proto
} = require('@whiskeysockets/baileys');

class MongoStore {
  constructor(uri, dbName, sessionCollection = 'baileys_auth', userCollection = 'samar_users') {
    if (!uri) throw new Error('MONGODB_URI is required');
    this.uri = uri;
    this.dbName = dbName || undefined;
    this.sessionCollection = sessionCollection;
    this.userCollection = userCollection;
    this.client = new MongoClient(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 15000,
      connectTimeoutMS: 15000,
      retryWrites: true
    });
    this.db = null;
  }

  async connect() {
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    this.auth = this.db.collection(this.sessionCollection);
    this.users = this.db.collection(this.userCollection);
    await Promise.all([
      this.auth.createIndex({ session: 1, kind: 1, type: 1, key: 1 }, { unique: true }),
      this.users.createIndex({ _id: 1 }, { unique: true })
    ]);
    await this.client.db('admin').command({ ping: 1 });
    return this;
  }

  async close() { await this.client.close(); }

  async loadUsers() {
    const docs = await this.users.find({}).toArray();
    const out = {};
    for (const doc of docs) {
      const phone = String(doc._id);
      const { _id, ...user } = doc;
      out[phone] = user;
    }
    return out;
  }

  async saveUser(phone, user) {
    await this.users.replaceOne(
      { _id: String(phone) },
      { _id: String(phone), ...user },
      { upsert: true }
    );
  }

  async clearAuth(session) {
    await this.auth.deleteMany({ session: String(session) });
  }

  async saveUsers(users) {
    const entries = Object.entries(users || {});
    if (!entries.length) return;
    const ops = entries.map(([phone, user]) => ({
      replaceOne: { filter: { _id: String(phone) }, replacement: { _id: String(phone), ...user }, upsert: true }
    }));
    await this.users.bulkWrite(ops, { ordered: false });
  }

  authState(session) {
    const collection = this.auth;
    const sessionId = String(session);
    const docId = (kind, type, key) => ({ session: sessionId, kind, type: type || '', key: key || '' });
    const encode = value => JSON.parse(JSON.stringify(value, BufferJSON.replacer));
    const decode = value => JSON.parse(JSON.stringify(value), BufferJSON.reviver);

    const saveCreds = async creds => {
      await collection.replaceOne(
        docId('creds', '', ''),
        { ...docId('creds', '', ''), data: encode(creds), updatedAt: new Date() },
        { upsert: true }
      );
    };

    const loadCreds = async () => {
      const doc = await collection.findOne(docId('creds', '', ''));
      return doc ? decode(doc.data) : null;
    };

    const keys = {
      get: async (type, ids) => {
        if (!ids?.length) return {};
        const docs = await collection.find({
          session: sessionId,
          kind: 'key',
          type,
          key: { $in: ids.map(String) }
        }).toArray();
        const out = {};
        for (const id of ids) {
          const doc = docs.find(x => x.key === String(id));
          if (!doc) continue;
          let value = decode(doc.data);
          if (type === 'app-state-sync-key' && value) {
            try { value = proto.Message.AppStateSyncKeyData.fromObject(value); } catch {}
          }
          out[id] = value;
        }
        return out;
      },
      set: async data => {
        const ops = [];
        for (const [type, values] of Object.entries(data || {})) {
          for (const [id, value] of Object.entries(values || {})) {
            const filter = docId('key', type, id);
            if (value == null) {
              ops.push({ deleteOne: { filter } });
            } else {
              ops.push({ replaceOne: {
                filter,
                replacement: { ...filter, data: encode(value), updatedAt: new Date() },
                upsert: true
              }});
            }
          }
        }
        if (ops.length) await collection.bulkWrite(ops, { ordered: false });
      }
    };

    return {
      async init() {
        const existing = await loadCreds();
        return existing || initAuthCreds();
      },
      saveCreds,
      state: { creds: null, keys }
    };
  }
}

module.exports = { MongoStore };
