const express = require('express');
const session = require('express-session');
const mysql = require('mysql2/promise');
const path = require('path');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const app = express();
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const sharp = require('sharp');
const winston = require('winston');
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const chokidar = require('chokidar');

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.json(),
    transports: [
        new winston.transports.File({ filename: 'wal.log' })
    ]
});

const pool = mysql.createPool({
  host: 'mysql',
  user: 'root',
  password: 'password',
  database: 'surface_inspection'
});

app.use(session({
  secret: 'your_secret_key', 
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));

const websocketConnections = new Set();

wss.on('connection', ws => {
  websocketConnections.add(ws);

  console.log('새로운 연결이 감지되었습니다. 현재 활성화된 연결이 있나요? ', checkAnyWebSocketConnection());
  ws.on('message', async message => {
    if (Buffer.isBuffer(message)) {
      message = message.toString();
    }

    let parsedMessage;
    try {
      parsedMessage = parseMessage(message); 
      console.log(`Received message: ${message}`);
      console.log(`Parsed Defect value: ${parsedMessage.Defect}`);
      const { Mac, Defect } = parsedMessage;
      await updateDeviceCount(Mac, Defect);
    } catch (error) {
      console.error('Error processing message:', error);
      return;
    }

    if (parsedMessage && parsedMessage.Defect) {
      try {
        await saveImage(parsedMessage.imageData, parsedMessage.imageWidth, parsedMessage.imageHeight);
        console.log('Image saved successfully');
      } catch (error) {
        console.error('Error saving image:', error);
      }
    } else {
      console.log('Defect is false, image not saved');
    }
  });
});

async function saveImage(imageData, imageWidth, imageHeight) {
  const now = new Date();
  const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const filename = `${timestamp}.jpg`;

  const directoryPath = path.join(__dirname, '/devicetype/failimage/');
  const filePath = path.join(directoryPath, filename);

  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true });
  }

  const buffer = Buffer.from(imageData.split(','), 'base64');

  try {
    await sharp(buffer, {
      raw: {
        width: imageWidth,
        height: imageHeight,
        channels: 3
      }
    }).toFile(filePath);
    console.log('Image saved to', filePath);
  } catch (err) {
    console.error('Error saving image:', err);
    throw err;
  }
}

async function updateDeviceCount(Mac, Defect) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    logger.info('Starting transaction for update operation', {
      operation: 'update',
      details: { Mac, Defect }
    });

    const [results] = await connection.query('SELECT * FROM device WHERE devicetype = ?', [Mac]);

    if (results.length > 0) {
      const columnToUpdate = Defect ? 'successcount' : 'failcount';
      await connection.query(`UPDATE device SET ${columnToUpdate} = ${columnToUpdate} + 1 WHERE devicetype = ?`, [Mac]);
      console.log(`Device ${Mac} count updated`);

      logger.info('Transaction committed successfully');
    } else {
      console.log(`No device found with Mac = ${Mac}`);
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    logger.error('Transaction rolled back due to error', { error: error.message });
    throw error;
  } finally {
    connection.release();
  }
}

function parseMessage(message) {
  console.log('Parsing message:', message);

  const parts = message.split(', ');
  if (parts.length < 5) {
    throw new Error('Incomplete message');
  }

  const Mac = parts[0].split(': ')[1];
  const Defect = parts[1].split(': ')[1] === 'True';
  const ImageWidth = parseInt(parts[2].split(': ')[1]);
  const ImageHeight = parseInt(parts[3].split(': ')[1]);
  const imageData = parts.slice(4).join(',');

  if (!Mac || isNaN(ImageWidth) || isNaN(ImageHeight) || !imageData) {
    throw new Error('Invalid message format');
  }

  return {
    Mac,
    Defect,
    imageWidth: ImageWidth,
    imageHeight: ImageHeight,
    imageData
  };
}

function checkAnyWebSocketConnection() {
  return websocketConnections.size > 0;
}

pool.getConnection()
  .then(connection => {
    console.log('Connected to the database');
    connection.release();
  })
  .catch(err => {
    console.error('Error connecting to the database:', err);
  });

app.get('/', (req, res) => {
  res.render('home');
});

app.get('/signup', (req, res) => {
  res.render('signup');
});

app.post('/signup', async (req, res) => {
  const { name, email, username, password, address, phone } = req.body;

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const query = 'INSERT INTO users (name, email, username, password, address, phone) VALUES (?, ?, ?, ?, ?, ?)';

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      logger.info('Starting transaction for user signup', {
        operation: 'signup',
        details: { username }
      });

      await connection.query(query, [name, email, username, hashedPassword, address, phone]);
      await connection.commit();

      logger.info('User signup committed successfully');
      res.redirect('/');
    } catch (error) {
      await connection.rollback();
      logger.error('Transaction rolled back due to error', { error: error.message });
      res.status(500).send('Error registering new user');
    } finally {
      connection.release();
    }
  } catch (error) {
    res.status(500).send('Server error');
  }
});

app.get('/login', (req, res) => {
  res.render('login');
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const query = 'SELECT * FROM users WHERE username = ?';

  try {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [results] = await connection.query(query, [username]);

      if (results.length === 0) {
        return res.status(401).send('Username or password is incorrect');
      }

      const user = results[0];
      const match = await bcrypt.compare(password, user.password);

      if (match) {
        req.session.userId = user.id;
        req.session.username = user.username;
        await connection.commit();
        res.redirect('/userhome'); 
      } else {
        await connection.rollback();
        res.status(401).send('Username or password is incorrect');
      }
    } catch (error) {
      await connection.rollback();
      res.status(500).send('An error occurred during the login process');
    } finally {
      connection.release();
    }
  } catch (err) {
    res.status(500).send('Server error');
  }
});

app.get('/userhome', isLoggedIn, (req, res) => {
  res.render('userhome', { userId: req.session.userId });
});

function isLoggedIn(req, res, next) {
  if (req.session.userId) {
    next();
  } else {
    res.redirect('/login');
  }
}

app.get('/userhome/mypage', isLoggedIn, (req, res) => {
  const userId = req.session.userId; 
  if (!userId) {
    return res.status(401).send('Unauthorized: No session found');
  }

  const directoryPath = path.join(__dirname, '/devicetype/failimage/');
  fs.readdir(directoryPath, (err, files) => {
    if (err) {
      return res.status(500).send('Unable to read directory');
    }

    const sortedFiles = files.sort((a, b) => b.localeCompare(a)).slice(0, 5);
    const filePaths = sortedFiles.map(file => `/devicetype/failimage/${file}`);

    res.render('mypage', { images: filePaths, userId: userId }); 
  });
});

app.post('/userhome/mypage/device', isLoggedIn, async (req, res) => {
  const { devicename, devicetype } = req.body;
  const userId = req.session.userId;
  const errorpath = `/${devicetype}/failimage/`;
  const successcount = 0;
  const failcount = 0;
  const query = 'INSERT INTO device (id, devicename, devicetype, errorpath, successcount, failcount) VALUES (?, ?, ?, ?, ?, ?)';

  try {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      logger.info('Starting transaction for device registration', {
        operation: 'register device',
        details: { devicename, devicetype }
      });

      await connection.query(query, [userId, devicename, devicetype, errorpath, successcount, failcount]);
      await connection.commit();

      logger.info('Device registration committed successfully');
      res.send('Device registered successfully');
    } catch (error) {
      await connection.rollback();
      logger.error('Transaction rolled back due to error', { error: error.message });
      res.status(500).send('Error registering device');
    } finally {
      connection.release();
    }
  } catch (err) {
    res.status(500).send('Server error');
  }
});

app.use('/devicetype/failimage', express.static(path.join(__dirname, 'devicetype/failimage')));

app.get('/userhome/mypage/data', isLoggedIn, async (req, res) => {
  const userId = req.session.userId;
  const websocketConnected = checkAnyWebSocketConnection();

  const countQuery = 'SELECT COUNT(*) AS deviceCount FROM device WHERE id = ?';

  try {
    const connection = await pool.getConnection();
    const [countResults] = await connection.query(countQuery, [userId]);
    const deviceCount = countResults[0].deviceCount;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    const sendData = async () => {
      const query = `
        SELECT deviceid, devicename, devicetype, errorpath, successcount, failcount
        FROM device
        WHERE id = ? AND Priority = 1
      `;

      try {
        const [results] = await connection.query(query, [userId]);
        const data = {
          devices: results,
          deviceCount: deviceCount,
          websocketStatus: websocketConnected ? 'ON' : 'OFF'
        };
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch (err) {
        console.error('Error executing query', err);
      }
    };

    sendData();

    const interval = setInterval(sendData, 2000);

    req.on('close', () => {
      clearInterval(interval);
      connection.release();
    });
  } catch (err) {
    console.error('Error executing count query', err);
  }
});

app.get('/get-latest-images', (req, res) => {
  const directoryPath = path.join(__dirname, '/devicetype/failimage/');

  fs.readdir(directoryPath, { withFileTypes: true }, (err, files) => {
    if (err) {
      console.error('Error reading directory', err);
      return res.status(500).send('Error reading directory');
    }

    const statPromises = files
      .filter(dirent => dirent.isFile())
      .map(dirent => fs.promises.stat(path.join(directoryPath, dirent.name)));

    Promise.all(statPromises).then(stats => {
      const fileStats = files.map((dirent, index) => ({
        name: dirent.name,
        time: stats[index].mtime.getTime()
      }));

      fileStats.sort((a, b) => b.time - a.time);

      const latestImages = fileStats.slice(0, 5).map(fileStat => `/devicetype/failimage/${fileStat.name}`);

      res.json(latestImages);
    }).catch(statErr => {
      console.error('Error retrieving file stats', statErr);
      res.status(500).send('Error retrieving file stats');
    });
  });
});

app.get('/userhome/mypage/device', isLoggedIn, (req, res) => {
  if (!req.session.userId) {
    return res.status(401).send('Unauthorized access');
  }
  res.render('device', { userId: req.session.userId });
});

app.get('/userhome/mypage/uploads', isLoggedIn, (req, res) => {
  if (!req.session.userId) {
    return res.status(401).send('Unauthorized access');
  }
  res.render('uploads', { userId: req.session.userId });
});

app.get('/userhome/mypage/devicelist', isLoggedIn, (req, res) => {
  if (!req.session.userId) {
    return res.status(401).send('Unauthorized access');
  }
  res.render('devicelist', { userId: req.session.userId });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
