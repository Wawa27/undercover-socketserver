const db = require('./db');

module.exports.getRandomWords = async function() {
  return (await db
    .getDatabase()
    .collection('words')
    .aggregate(
      [{ $sample: { size: 1 } }]
    ).toArray())[0];
};
