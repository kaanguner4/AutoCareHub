const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// 1. DATABASE CONNECTION
const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '1234', // Kurulumdaki şifreniz
    database: 'autocare_db'
});

db.connect(err => {
    if (err) {
        console.error('❌ Database connection failed:', err);
    } else {
        console.log('✅ Connected to MySQL Database Successfully!');
    }
});

// --- API ENDPOINTS ---

// A. USER REGISTRATION
app.post('/api/register', (req, res) => {
    const { name, email, phone, password } = req.body;
    const sql = "INSERT INTO users (name, email, phone, password) VALUES (?, ?, ?, ?)";
    
    db.query(sql, [name, email, phone, password], (err, result) => {
        if (err) {
            if(err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'This email is already registered.' });
            return res.status(500).json({ error: err.message });
        }
        res.json({ message: 'Registration successful!', userId: result.insertId });
    });
});

// B. LOGIN
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    const sql = "SELECT * FROM users WHERE email = ? AND password = ?";
    
    db.query(sql, [email, password], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        
        if (results.length > 0) {
            const user = results[0];
            delete user.password; 
            res.json({ success: true, user });
        } else {
            res.status(401).json({ success: false, message: 'Invalid email or password!' });
        }
    });
});

// C. ADD VEHICLE
app.post('/api/vehicles', (req, res) => {
    // Frontend 'userId' gönderiyor, veritabanı 'user_id' bekliyor.
    const { userId, brand, model, plate } = req.body;
    const sql = "INSERT INTO vehicles (user_id, brand, model, plate) VALUES (?, ?, ?, ?)";
    
    db.query(sql, [userId, brand, model, plate], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Vehicle added successfully', id: result.insertId });
    });
});

// D. GET USER'S VEHICLES
app.get('/api/vehicles/:userId', (req, res) => {
    const sql = "SELECT * FROM vehicles WHERE user_id = ?";
    db.query(sql, [req.params.userId], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results); // Frontend'e id, user_id, brand... döner
    });
});

// E. DELETE VEHICLE
app.delete('/api/vehicles/:id', (req, res) => {
    const sql = "DELETE FROM vehicles WHERE id = ?";
    db.query(sql, [req.params.id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Vehicle deleted successfully' });
    });
});

// F. CREATE APPOINTMENT (KRİTİK EŞLEŞTİRME BURADA)
app.post('/api/appointments', (req, res) => {
    // Frontend'den gelen isimler: car, service
    const { userId, car, service, price, date, note } = req.body;
    
    // Veritabanı sütunları: car_info, services
    const sql = "INSERT INTO appointments (user_id, car_info, services, price, date, note) VALUES (?, ?, ?, ?, ?, ?)";
    
    db.query(sql, [userId, car, service, price, date, note], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Appointment created successfully', id: result.insertId });
    });
});

// G. GET APPOINTMENTS
app.get('/api/appointments', (req, res) => {
    const userId = req.query.userId;
    let sql = "SELECT * FROM appointments";
    let params = [];

    if (userId) {
        sql += " WHERE user_id = ?";
        params.push(userId);
    }

    db.query(sql, params, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results); 
        // DİKKAT: Frontend'e 'car_info' ve 'services' olarak dönecek. 
        // main.js ve admin.js bu isimleri karşılayacak şekilde ayarlandı.
    });
});

// H. UPDATE APPOINTMENT STATUS
app.put('/api/appointments/:id/status', (req, res) => {
    const { status } = req.body;
    const sql = "UPDATE appointments SET status = ? WHERE id = ?";
    
    db.query(sql, [status, req.params.id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Status updated successfully' });
    });
});

// I. DELETE APPOINTMENT
app.delete('/api/appointments/:id', (req, res) => {
    const sql = "DELETE FROM appointments WHERE id = ?";
    db.query(sql, [req.params.id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Appointment deleted successfully' });
    });
});

// J. GET ALL USERS (Admin Paneli İçin)
app.get('/api/users', (req, res) => {
    const sql = "SELECT id, name, email, phone FROM users";
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// START SERVER
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server is running at: http://localhost:${PORT}`);
});