const { MongoClient } = require('mongodb');
const MongoStore = require('connect-mongo');

async function connectMongo(uri) {
  try {
    const client = new MongoClient(uri, {
      connectTimeoutMS: 30000,
      socketTimeoutMS: 30000,
    });

    await client.connect();

    const store = MongoStore.create({
      client: client,
      dbName: 'samar-md',
      autoRemove: 'disabled',
      // Disable auto index creation to prevent Collection.createIndex crashes
      autoIndex: false, 
      touchAfter: 24 * 3600
    });

    console.log("Successfully connected to MongoDB!");
    return store;
  } catch (error) {
    console.error("MongoDB Connection Error (Bypassed):", error.message);
    return null;
  }
}

module.exports = { connectMongo };
