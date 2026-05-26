const sqlite3 = require('sqlite3').verbose();
const dbPath = process.env.DATABASE_PATH || './calgentic.db';
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    }
});

const userId = 'dummy_user_id_123';
const name = 'Test User';
const email = 'test@calgentic.com';
const mobileNumber = '9876543210';
const password = 'password123';

db.serialize(() => {
    db.run(`INSERT OR REPLACE INTO users (user_id, name, email, mobile_number, password) VALUES (?, ?, ?, ?, ?)`,
        [userId, name, email, mobileNumber, password],
        function(err) {
            if (err) {
                console.error('Failed to insert dummy user:', err.message);
                process.exit(1);
            }
            console.log('Dummy user inserted successfully!');
            db.close();
        });
});
