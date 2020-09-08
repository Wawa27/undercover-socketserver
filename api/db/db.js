const MongoClient = require('mongodb').MongoClient;
const uri = `mongodb://${process.env.DB_HOST}:${process.env.DB_PORT}`;

const options = {
  useUnifiedTopology: true
};

let database;
let connection;

new MongoClient(uri, options).connect().then(client => {
  database = client.db('undercover');
  connection = client;
  console.log('Connected to MongoDB')
});

function getConnection() {
  return connection;
}

function getDatabase() {
  return database;
}

function close() {
  connection.close();
}

module.exports = {
  getConnection,
  getDatabase,
  close
};
