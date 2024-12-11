const express = require('express');
const mysql = require('mysql2');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const cheerio = require('cheerio');
const OpenAI = require('openai');
const puppeteer = require('puppeteer-firefox');
const iconv = require('iconv-lite');
const csv = require('csv-parser');
const fs = require('fs');
const xml2js = require('xml2js');
const mqtt = require('mqtt');
const cors = require('cors');
const { createReadStream } = require('fs');

// XML 파서 설정
const parser = new xml2js.Parser({ explicitArray: false });

// Express 앱 및 서버 설정
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// MQTT 설정
const MQTT_SERVER = "localhost";  // 라즈베리파이 IP (MQTT 브로커 위치)
const MQTT_PORT = 1883;
const SERVER_IP = "0.0.0.0" // 모든 인터페이스에서 수신하도록 설정
const HTTP_PORT = 3000;

// 바코드 스캐너 설정 추가
const SCANNER_DEVICE = '/dev/input/by-id/usb-SM_SM-2D_PRODUCT_HID_KBW_APP-000000000-event-kbd';
let barcodeBuffer = '';
let lastKeyTime = Date.now();
const KEY_TIMEOUT = 50;

// 네이버 API 설정
const NAVER_CLIENT_ID = 'your id';     // 발급받은 클라이언트 ID
const NAVER_CLIENT_SECRET = 'your secret'; // 발급받은 클라이언트 시크릿

// 키 매핑
const KEY_MAP = {
  2: '1', 3: '2', 4: '3', 5: '4', 6: '5',
  7: '6', 8: '7', 9: '8', 10: '9', 11: '0'
};

// 현재 모드 저장
let currentMode = 'auto';

// MQTT 클라이언트 설정
const mqttClient = mqtt.connect(`mqtt://${MQTT_SERVER}:${MQTT_PORT}`, {
  reconnectPeriod: 1000,
  connectTimeout: 10000,
  clean: true
});


// MQTT 이벤트 핸들러
mqttClient.on('connect', () => {
  console.log('Connected to MQTT broker');

  mqttClient.publish('refrigerator/mode', currentMode, { retain: true }, (err) => {
    if (err) {
      console.error('Failed to publish initial mode:', err);
    } else {
      console.log('Published initial mode:', currentMode);
    }
  });
});

mqttClient.on('error', (error) => {
  console.error('MQTT error:', error);
});

mqttClient.on('close', () => {
  console.log('MQTT connection closed');
});

mqttClient.on('reconnect', () => {
  console.log('Trying to reconnect to MQTT broker...');
});


// 클라이언트 관리를 위한 Map
const clients = new Map();

// 식품안전나라 API 설정
const FOOD_API_CONFIG = {
  baseUrl: 'yourUrl',
  serviceKey: 'yourKey'
};

// CSV 파일 경로 설정
const nutritionFoodPath = path.join(__dirname, 'data', 'nutrition_food.csv');
const nutritionStandardPath = path.join(__dirname, 'data', 'nutrition_standard.csv');

// CSV 파일 존재 여부 확인
if (!fs.existsSync(nutritionFoodPath)) {
  console.error('영양성분 CSV 파일을 찾을 수 없습니다:', nutritionFoodPath);
}
if (!fs.existsSync(nutritionStandardPath)) {
  console.error('영양섭취기준 CSV 파일을 찾을 수 없습니다:', nutritionStandardPath);
}

// MySQL 데이터베이스 연결 설정
const dbConfig = {
  host: 'localhost',
  user: 'root',
  password: 'itc801',
  database: 'refrigerator',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 60000
};

const db = mysql.createPool(dbConfig);

// 데이터베이스 연결 테스트
db.getConnection((err, connection) => {
  if (err) {
    console.error('Database connection error:', err);
    return;
  }
  console.log('Successfully connected to database');
  connection.release();
});

// 데이터베이스 연결 상태 확인
setInterval(async () => {
  try {
    const connection = await db.promise().getConnection();
    await connection.ping();
    connection.release();
  } catch (err) {
    console.error('Database ping failed:', err);
  }
}, 30000);

// connect 부분 삭제하고 대신 연결 테스트 추가
db.getConnection((err, connection) => {
  if (err) {
    console.error('MySQL connection error:', err);
  } else {
    console.log('MySQL connected...');
    connection.release();
  }
});

// 주기적인 연결 상태 확인 추가
setInterval(() => {
  db.query('SELECT 1', (err) => {
    if (err) {
      console.error('Database ping error:', err);
    }
  });
}, 30000);

// OpenAI API 설정
const openai = new OpenAI({
  apiKey: 'your key'
});

// 미들웨어 설정
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'views')));
app.use(cors({
  origin: '*',  // 모든 도메인 허용 (개발용)
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept']
}));

// CSV 데이터 로드 함수, EUC-KR 인코딩된 CSV 파일을 읽어서 UTF-8로 변환하여 데이터 반환
function loadCsvData(filePath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      console.error('CSV 파일을 찾을 수 없습니다:', filePath);
      reject(new Error('CSV 파일을 찾을 수 없습니다.'));
      return;
    }

    const results = [];
    fs.createReadStream(filePath)
      .pipe(iconv.decodeStream('euc-kr'))
      .pipe(csv({
        mapHeaders: ({ header }) => header.trim()
      }))
      .on('data', (data) => {
        Object.keys(data).forEach(key => {
          if (data[key]) {
            data[key] = data[key].toString().trim();
          }
        });
        results.push(data);
      })
      .on('end', () => {
        if (results.length === 0) {
          reject(new Error('CSV 파일에 데이터가 없습니다.'));
          return;
        }
        console.log('CSV 데이터 로드 완료:', results.length, '개의 항목');
        resolve(results);
      })
      .on('error', (error) => {
        console.error('CSV 파일 읽기 오류:', error);
        reject(error);
      });
  });
}

// 바코드로 상품 검색하는 함수 (Firefox 사용)
async function findProductByBarcode(barcode) {
    try {
      const url = `https://gs1.koreannet.or.kr/pr/${barcode}`;
      console.log(`바코드 조회 URL: ${url}`);
  
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'ko-KR,ko;q=0.8,en-US;q=0.5,en;q=0.3',
        },
        timeout: 30000
      });
  
      const $ = cheerio.load(response.data);
      const productName = $('h3').text().trim();
      
      let info = {
        country: '',
        company: '',
        CLS_NM_1: '',
        CLS_NM_2: '',
        CLS_NM_3: ''
      };
  
      $('table tr').each((_, row) => {
        const label = $(row).find('th').text().trim();
        const value = $(row).find('td').text().trim();
        
        switch(label) {
          case '제조국가':
            info.country = value;
            break;
          case '제조사/생산자':
            info.company = value;
            break;
          case 'KAN 상품분류':
            const categories = value.split('>').map(cat => cat.trim());
            info.CLS_NM_1 = categories[0] || '';
            info.CLS_NM_2 = categories[1] || '';
            info.CLS_NM_3 = categories[2] || '';
            break;
        }
      });
  
      if (productName) {
        console.log('제품 정보 찾음:', { productName, ...info });
        return {
          success: true,
          productName,
          ...info,
          barcode
        };
      } else {
        throw new Error('제품 정보를 찾을 수 없습니다.');
      }
    } catch (error) {
      console.error('제품 검색 오류:', error);
      return {
        success: false,
        error: error.message,
        barcode: barcode
      };
    }
  }

// 나이 그룹 확인 함수, 입력받은 나이가 어느 그룹에 속하는지 확인

function checkAgeGroup(age, groupRange) {
  if (typeof age !== 'number') {
    age = parseInt(age);
  }

  const ranges = {
    "15-18세": age >= 15 && age <= 18,
    "19-29세": age >= 19 && age <= 29,
    "30-49세": age >= 30 && age <= 49,
    "50-64세": age >= 50 && age <= 64,
    "65-74세": age >= 65 && age <= 74,
    "75세 이상": age >= 75
  };

  return ranges[groupRange] || false;
}

// 기본 페이지 라우팅 설정
app.get('/home', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'home.html'));
});

app.get('/products', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'products.html'));
});

app.get('/profile', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'profile.html'));
});

app.get('/recommendation', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'recommendation.html'));
});

app.get('/recommendation2', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'recommendation2.html'));
});

app.get('/oder', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'oder.html'));
});

// 네이버 쇼핑 검색 API 엔드포인트
app.get('/api/search-shopping', async (req, res) => {
  const { keyword } = req.query;
  if (!keyword) {
    return res.status(400).json({ error: '검색어가 필요합니다.' });
  }

  try {
    const response = await axios.get('https://openapi.naver.com/v1/search/shop.json', {
      params: {
        query: keyword,
        display: 5,  // 검색 결과 개수
        sort: 'sim'  // 정확도순 정렬
      },
      headers: {
        'X-Naver-Client-Id': NAVER_CLIENT_ID,
        'X-Naver-Client-Secret': NAVER_CLIENT_SECRET
      }
    });

    // 검색 결과 데이터 가공
    const items = response.data.items.map(item => ({
      name: item.title.replace(/<[^>]*>/g, ''),  // HTML 태그 제거
      price: `${Number(item.lprice).toLocaleString()}원`,
      link: item.link,
      image: item.image,
      mall: item.mallName
    }));

    res.json(items);
  } catch (error) {
    console.error('네이버 쇼핑 검색 오류:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});


// 수량 기준 제품 목록 조회 API
app.get('/api/consumption-pattern/quantity', (req, res) => {
  const query = `
    SELECT 
      p.product_name,
      SUM(cl.quantity_used) as total_quantity,
      MAX(cl.usage_date) as last_used
    FROM consumption_logs cl
    JOIN products p ON cl.product_id = p.id
    GROUP BY p.id, p.product_name
    ORDER BY total_quantity DESC`;

  db.query(query, (err, results) => {
    if (err) {
      console.error('수량 목록 조회 오류:', err);
      return res.status(500).json({
        success: false,
        error: '데이터 조회 실패'
      });
    }

    res.json({
      success: true,
      products: results
    });
  });
});

// 소비패턴 정보 조회 API
app.get('/api/consumption-pattern', (req, res) => {
  const period = req.query.period || 'month';
  let dateFilter;

  switch (period) {
    case 'week':
      dateFilter = 'AND cl.usage_date >= DATE_SUB(NOW(), INTERVAL 1 WEEK)';
      break;
    case '3months':
      dateFilter = 'AND cl.usage_date >= DATE_SUB(NOW(), INTERVAL 3 MONTH)';
      break;
    default:
      dateFilter = 'AND cl.usage_date >= DATE_SUB(NOW(), INTERVAL 1 MONTH)';
  }

  const query = `
    SELECT 
      p.product_name,
      SUM(cl.quantity_used) as total_quantity
    FROM consumption_logs cl
    JOIN products p ON cl.product_id = p.id
    WHERE 1=1 ${dateFilter}
    GROUP BY p.id, p.product_name
    ORDER BY total_quantity DESC`;

  db.query(query, (err, results) => {
    if (err) {
      console.error('소비패턴 조회 오류:', err);
      return res.status(500).json({
        success: false,
        error: '데이터 조회 실패'
      });
    }

    const totalProducts = results.length;
    const totalQuantity = results.reduce((sum, item) => sum + item.total_quantity, 0);
    const monthlyAverage = totalQuantity / (period === 'week' ? 0.25 : period === '3months' ? 3 : 1);

    res.json({
      success: true,
      productConsumption: results,
      totalProducts,
      monthlyAverage
    });
  });
});

// 서버의 알레르기 정보 검색 API
app.get('/api/products/allergy', async (req, res) => {
  const productName = req.query.name;
  if (!productName) {
    return res.status(400).json({
      success: false,
      error: '제품명을 입력해주세요.'
    });
  }

  try {
    const url = `${FOOD_API_CONFIG.baseUrl}?ServiceKey=${FOOD_API_CONFIG.serviceKey}&prdlstNm=${encodeURIComponent(productName)}`;
    const response = await axios.get(url);
    const result = await parser.parseStringPromise(response.data);

    if (!result.response?.body?.items?.item) {
      return res.json({
        success: true,
        data: []
      });
    }

    // 단일 항목과 배열 모두 처리
    const items = Array.isArray(result.response.body.items.item)
      ? result.response.body.items.item
      : [result.response.body.items.item];

    // 중복 제거 및 데이터 매핑
    const uniqueProducts = {};
    items.forEach(item => {
      const barcode = item.barcode || 'Unknown';
      if (!uniqueProducts[barcode]) {
        uniqueProducts[barcode] = {
          제품명: item.prdlstNm || '제품명 없음',
          바코드: barcode,
          알레르기정보: item.allergy || '정보 없음',
          원재료명: item.rawmtrl || '정보 없음',
          영양성분: item.nutrient || '정보 없음'
        };
      }
    });

    res.json({
      success: true,
      data: Object.values(uniqueProducts)
    });

  } catch (error) {
    console.error('알레르기 정보 검색 오류:', error);
    res.status(500).json({
      success: false,
      error: '알레르기 정보 검색 중 오류가 발생했습니다.'
    });
  }
});

// 소비패턴 분석 API
app.get('/api/consumption-pattern', async (req, res) => {
  try {
    // 제품별 총 소비량 조회
    const productConsumptionQuery = `
      SELECT 
        p.product_name,
        SUM(cl.quantity_used) as total_quantity
      FROM consumption_logs cl
      JOIN products p ON cl.product_id = p.id
      GROUP BY p.id, p.product_name
      ORDER BY total_quantity DESC
    `;

    // 상위 소비 제품 조회 (최근 사용 날짜 포함)
    const topProductsQuery = `
      SELECT 
        p.product_name,
        SUM(cl.quantity_used) as total_quantity,
        MAX(cl.usage_date) as last_used
      FROM consumption_logs cl
      JOIN products p ON cl.product_id = p.id
      GROUP BY p.id, p.product_name
      ORDER BY total_quantity DESC
      LIMIT 5
    `;

    const [productConsumption] = await db.promise().query(productConsumptionQuery);
    const [topProducts] = await db.promise().query(topProductsQuery);

    // 추가 통계 계산
    const totalConsumption = productConsumption.reduce((sum, item) => sum + item.total_quantity, 0);

    // 각 제품의 소비 비율 계산
    productConsumption.forEach(item => {
      item.percentage = ((item.total_quantity / totalConsumption) * 100).toFixed(1);
    });

    res.json({
      success: true,
      productConsumption,
      topProducts,
      totalConsumption
    });

  } catch (error) {
    console.error('소비패턴 분석 오류:', error);
    res.status(500).json({
      success: false,
      error: '소비패턴 분석 중 오류가 발생했습니다.'
    });
  }
});

// 특정 제품 정보 조회 API
app.get('/api/products/:id', (req, res) => {
  const productId = req.params.id;
  const query = 'SELECT * FROM products WHERE id = ?';

  db.query(query, [productId], (err, results) => {
    if (err) {
      console.error('제품 조회 오류:', err);
      return res.status(500).json({ error: '제품 조회 실패' });
    }
    if (results.length === 0) {
      return res.status(404).json({ error: '제품을 찾을 수 없습니다' });
    }
    res.json(results[0]);
  });
});

// 소비 기록 추가 API
app.post('/api/log-consumption', (req, res) => {
  const { product_id, quantity_used } = req.body;
  const usage_date = new Date();

  if (!product_id || !quantity_used) {
    return res.status(400).json({ error: '필수 필드가 누락되었습니다' });
  }

  const insertQuery = `
    INSERT INTO consumption_logs 
    (product_id, quantity_used, usage_date) 
    VALUES (?, ?, ?)
  `;

  db.query(insertQuery, [product_id, quantity_used, usage_date], (err, result) => {
    if (err) {
      console.error('소비 기록 추가 오류:', err);
      return res.status(500).json({ error: '소비 기록 추가 실패' });
    }

    res.status(201).json({
      success: true,
      message: '소비 기록이 추가되었습니다',
      log_id: result.insertId
    });
  });
});

// 특정 제품의 소비 기록 조회 API
app.get('/api/consumption/:productId', (req, res) => {
  const productId = req.params.productId;

  const query = `
    SELECT 
      cl.id,
      cl.quantity_used,
      cl.usage_date,
      p.product_name
    FROM consumption_logs cl
    JOIN products p ON cl.product_id = p.id
    WHERE cl.product_id = ?
    ORDER BY cl.usage_date DESC
  `;

  db.query(query, [productId], (err, results) => {
    if (err) {
      console.error('소비 기록 조회 오류:', err);
      return res.status(500).json({ error: '소비 기록 조회 실패' });
    }
    res.json(results);
  });
});

// 기간별 소비 통계 조회 API
app.get('/api/consumption-stats', (req, res) => {
  const { start_date, end_date } = req.query;

  const query = `
    SELECT 
      p.product_name,
      SUM(cl.quantity_used) as total_consumed,
      COUNT(*) as consumption_count,
      MIN(cl.usage_date) as first_usage,
      MAX(cl.usage_date) as last_usage
    FROM consumption_logs cl
    JOIN products p ON cl.product_id = p.id
    WHERE cl.usage_date BETWEEN ? AND ?
    GROUP BY p.id, p.product_name
    ORDER BY total_consumed DESC
  `;

  db.query(query, [start_date || '1970-01-01', end_date || new Date()], (err, results) => {
    if (err) {
      console.error('소비 통계 조회 오류:', err);
      return res.status(500).json({ error: '소비 통계 조회 실패' });
    }
    res.json(results);
  });
});

// 제품 수량 업데이트 API
app.put('/api/update-product/:id', (req, res) => {
  const productId = req.params.id;
  const newQuantity = parseInt(req.body.quantity);

  // 현재 수량 조회
  db.query('SELECT quantity FROM products WHERE id = ?', [productId], (err, results) => {
    if (err) {
      console.error('제품 조회 오류:', err);
      return res.status(500).json({ error: '데이터베이스 오류' });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: '제품을 찾을 수 없습니다' });
    }

    const currentQuantity = results[0].quantity;
    const quantityDifference = currentQuantity - newQuantity;

    // 수량이 감소한 경우에만 소비 로그 기록
    if (quantityDifference > 0) {
      const logQuery = `
        INSERT INTO consumption_logs 
        (product_id, quantity_used, usage_date) 
        VALUES (?, ?, NOW())
      `;

      db.query(logQuery, [productId, quantityDifference], (logErr) => {
        if (logErr) {
          console.error('소비 로그 기록 오류:', logErr);
          return res.status(500).json({ error: '소비 로그 기록 실패' });
        }

        // 제품 수량 업데이트
        updateProductQuantity();
      });
    } else {
      // 수량 증가 또는 변화 없음
      updateProductQuantity();
    }
  });

  function updateProductQuantity() {
    const updateQuery = `
      UPDATE products 
      SET quantity = ? 
      WHERE id = ?
    `;

    db.query(updateQuery, [Math.max(0, newQuantity), productId], (updateErr) => {
      if (updateErr) {
        console.error('제품 수량 업데이트 오류:', updateErr);
        return res.status(500).json({ error: '제품 수량 업데이트 실패' });
      }
      res.json({ message: '제품 수량이 업데이트되었습니다' });
    });
  }
});

// 상태 정보 조회 API
app.get('/api/status', (req, res) => {
  const query = `
    SELECT 
      cold_temperature,
      cold_humidity,
      cold_gas,
      frozen_temperature, 
      frozen_humidity,
      frozen_gas,
      measured_at as timestamp
    FROM status 
    ORDER BY measured_at DESC 
    LIMIT 1`;

  db.query(query, (err, results) => {
    if (err || results.length === 0) {
      console.log('기본 상태 데이터 반환');
      // 데이터가 없는 경우 기본값 반환
      return res.json({
        cold_temperature: 4.0,
        cold_humidity: 70.0,
        cold_gas: 0.0,
        frozen_temperature: -20.0,
        frozen_humidity: 3.0,
        frozen_gas: 0.0,
        timestamp: new Date()
      });
    }
    res.json(results[0]);
  });
});

// 문 상태 조회 API
app.get('/api/door', (req, res) => {
  const query = `
    SELECT 
      cold_door,
      frozen_door,
      measured_at as timestamp
    FROM door 
    ORDER BY measured_at DESC 
    LIMIT 1`;

  db.query(query, (err, results) => {
    if (err || results.length === 0) {
      console.log('기본 문 상태 데이터 반환');
      // 데이터가 없는 경우 기본값 반환
      return res.json({
        cold_door: '닫힘',
        frozen_door: '닫힘',
        timestamp: new Date()
      });
    }
    res.json(results[0]);
  });
});


// 장치 제어 관련 API
app.get('/mode', (req, res) => {
  console.log('Mode request received, current mode:', currentMode);
  res.json({ mode: currentMode });
});

// 서버의 모드 변경 API 수정
app.post('/mode/:mode', (req, res) => {
  const { mode } = req.params;
  console.log('Mode change request received:', mode);

  if (mode !== 'auto' && mode !== 'manual') {
    console.log('Invalid mode requested:', mode);
    return res.status(400).json({
      success: false,
      mode: currentMode,
      error: 'Invalid mode'
    });
  }

  mqttClient.publish('refrigerator/mode', mode, { qos: 1 }, (err) => {
    if (err) {
      console.error('Failed to publish mode:', err);
      return res.status(500).json({
        success: false,
        mode: currentMode,
        error: 'Failed to change mode'
      });
    }

    currentMode = mode;
    console.log('Mode successfully changed to:', mode);
    res.json({
      success: true,
      mode: currentMode
    });
  });
});

// MQTT 연결 상태 모니터링 추가
mqttClient.on('connect', () => {
  console.log('Connected to MQTT broker');
});

mqttClient.on('error', (error) => {
  console.error('MQTT error:', error);
});

mqttClient.on('close', () => {
  console.log('MQTT connection closed');
});

app.get('/device/:device/:action', (req, res) => {
  const { device, action } = req.params;

  if (currentMode !== 'manual') {
    return res.status(400).json({ error: 'Not in manual mode' });
  }

  const topic = `refrigerator/${device}`;
  mqttClient.publish(topic, action, { qos: 1 }, (err) => {
    if (err) {
      console.error('Failed to publish device control:', err);
      return res.status(500).json({ error: 'Failed to control device' });
    }
    res.json({ status: 'success', device, action });
  });
});

// 바코드 검색 API 엔드포인트
app.post('/api/barcode/search', async (req, res) => {
  const { barcode } = req.body;
  if (!barcode) {
    return res.status(400).json({
      success: false,
      error: '바코드 번호가 필요합니다.'
    });
  }

  try {
    const result = await findProductByBarcode(barcode);
    if (result.success) {
      // 검색 성공 시 WebSocket으로 연결된 모든 클라이언트에게 알림
      const notification = {
        type: 'barcodeResult',
        ...result
      };

      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(notification));
        }
      });

      res.json(result);
    } else {
      res.status(404).json(result);
    }
  } catch (error) {
    console.error('바코드 검색 처리 오류:', error);
    res.status(500).json({
      success: false,
      error: '바코드 검색 중 오류가 발생했습니다.'
    });
  }
});

// 바코드 처리 및 알림 함수
async function processBarcodeAndNotify(barcode) {
  try {
    const result = await findProductByBarcode(barcode);
    // WebSocket으로 연결된 모든 클라이언트에게 결과 전송
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'barcodeResult',
          ...result
        }));
      }
    });
  } catch (error) {
    console.error('바코드 처리 오류:', error);
  }
}

// 바코드 스캐너 시작 함수는 웹소켓 설정 전에 추가
function startBarcodeReader() {
  try {
    console.log('Starting barcode reader...');
    const stream = createReadStream(SCANNER_DEVICE);
    
    stream.on('data', (data) => {
      for (let i = 0; i < data.length; i += 24) {
        const type = data.readUInt16LE(i + 16);
        const code = data.readUInt16LE(i + 18);
        const value = data.readInt32LE(i + 20);

        if (type === 1 && value === 1) {
          const currentTime = Date.now();
          if (currentTime - lastKeyTime > KEY_TIMEOUT) {
            barcodeBuffer = '';
          }
          lastKeyTime = currentTime;

          if (code === 28) { // Enter key
            if (barcodeBuffer.length > 0) {
              console.log('Scanned Barcode:', barcodeBuffer);
              processBarcodeAndNotify(barcodeBuffer);
              barcodeBuffer = '';
            }
          } else if (KEY_MAP[code]) {
            barcodeBuffer += KEY_MAP[code];
          }
        }
      }
    });

    stream.on('error', (error) => {
      console.error('Stream error:', error);
      setTimeout(startBarcodeReader, 1000);
    });
  } catch (error) {
    console.error('Failed to start barcode reader:', error);
    setTimeout(startBarcodeReader, 1000);
  }
}

// WebSocket 서버 설정
wss.on('connection', function connection(ws) {
  console.log('New client connected');
  let isAlive = true;

  ws.clientId = Math.random().toString(36).substring(7);
  clients.set(ws.clientId, ws);

  ws.on('pong', () => {
    isAlive = true;
  });

  const interval = setInterval(() => {
    if (!isAlive) {
      console.log('Connection lost for client:', ws.clientId);
      clients.delete(ws.clientId);
      ws.terminate();
      clearInterval(interval);
      return;
    }
    isAlive = false;
    ws.ping();
  }, 30000);

  ws.on('message', async function (message) {
    try {
      isAlive = true;
      const data = JSON.parse(message.toString());
      console.log('Received message from client:', ws.clientId, data);

      switch (data.type) {
        case 'ready':
          console.log('Client ready:', data.client, 'ID:', ws.clientId);
          ws.send(JSON.stringify({
            type: 'readyConfirm',
            success: true,
            clientId: ws.clientId
          }));
          break;

        case 'barcode':
          console.log('Processing barcode for client:', ws.clientId, data.data);
          try {
            const result = await findProductByBarcode(data.data);
            if (result.success) {
              const response = {
                type: 'barcodeResult',
                ...result
              };
              wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                  client.send(JSON.stringify(response));
                }
              });
            } else {
              ws.send(JSON.stringify({
                type: 'barcodeResult',
                success: false,
                error: result.error,
                barcode: data.data
              }));
            }
          } catch (error) {
            console.error('바코드 처리 오류:', error);
            ws.send(JSON.stringify({
              type: 'barcodeResult',
              success: false,
              error: error.message,
              barcode: data.data
            }));
          }
          break;

        default:
          console.log('Unknown message type:', data.type);
      }
    } catch (error) {
      console.error('Message handling error:', error);
      ws.send(JSON.stringify({
        type: 'error',
        success: false,
        error: error.message
      }));
    }
  });

  ws.on('error', function (error) {
    console.error('WebSocket error for client:', ws.clientId, error);
    clients.delete(ws.clientId);
  });

  ws.on('close', function () {
    console.log('Client disconnected:', ws.clientId);
    clients.delete(ws.clientId);
    clearInterval(interval);
  });
});

// 영양성분 검색 API, 식품명으로 영양성분 정보 검색

app.get('/api/nutrition/search', async (req, res) => {
  try {
    const name = req.query.name;
    if (!name) {
      return res.status(400).json({
        success: false,
        error: '검색어를 입력해주세요.'
      });
    }

    console.log('검색어:', name);

    // CSV 파일에서 영양성분 데이터 로드
    const nutritionData = await loadCsvData(nutritionFoodPath);

    // 검색어와 일치하는 식품 검색
    const results = nutritionData.filter(item => {
      if (!item['식품명']) return false;
      return item['식품명'].toString().toLowerCase().includes(name.toLowerCase());
    });

    // 검색 결과 매핑 및 데이터 변환
    const mappedResults = results.map(item => ({
      식품명: item['식품명'],
      열량: parseFloat(item['에너지(kcal)']) || 0,
      탄수화물: parseFloat(item['탄수화물(g)']) || 0,
      단백질: parseFloat(item['단백질(g)']) || 0,
      지방: parseFloat(item['지방(g)']) || 0,
      당류: parseFloat(item['당류(g)']) || 0,
      식이섬유: parseFloat(item['식이섬유(g)']) || 0,
      콜레스테롤: parseFloat(item['콜레스테롤(mg)']) || 0,
      나트륨: parseFloat(item['나트륨(mg)']) || 0,
      칼슘: parseFloat(item['칼슘(mg)']) || 0,
      철분: parseFloat(item['철(mg)']) || 0
    }));

    console.log('검색 결과 첫 번째 항목:', mappedResults[0]);

    res.json({
      success: true,
      data: mappedResults,
      count: mappedResults.length
    });
  } catch (error) {
    console.error('영양성분 검색 오류:', error);
    res.status(500).json({
      success: false,
      error: '영양성분 검색 중 오류가 발생했습니다.',
      message: error.message
    });
  }
});

// 영양 섭취 기준 API, 연령과 성별에 따른 권장 영양 섭취량 조회

app.get('/api/nutrition/standard', async (req, res) => {
  try {
    const { age, gender } = req.query;
    if (!age || !gender) {
      return res.status(400).json({
        success: false,
        error: '나이와 성별을 모두 입력해주세요.'
      });
    }

    // 연령대 그룹 확인 함수
    function getAgeGroup(age) {
      age = parseInt(age);
      if (age >= 15 && age <= 18) return "15-18세";
      if (age >= 19 && age <= 29) return "19-29세";
      if (age >= 30 && age <= 49) return "30-49세";
      if (age >= 50 && age <= 64) return "50-64세";
      if (age >= 65 && age <= 74) return "65-74세";
      if (age >= 75) return "75세 이상";
      return null;
    }

    const ageGroup = getAgeGroup(age);
    if (!ageGroup) {
      return res.status(400).json({
        success: false,
        error: '지원하지 않는 연령대입니다.'
      });
    }

    // 성별 파라미터 처리
    const genderParam = gender.toLowerCase();
    const koreanGender = genderParam === 'male' ? '남성' : '여성';

    console.log('검색 조건:', { ageGroup, gender: koreanGender });

    // 영양 섭취 기준 데이터 로드 및 검색
    const standardData = await loadCsvData(nutritionStandardPath);
    const standard = standardData.find(item => {
      return item['연령'] === ageGroup && item['성별'] === koreanGender;
    });

    if (!standard) {
      return res.status(404).json({
        success: false,
        error: '해당하는 영양섭취기준을 찾을 수 없습니다.',
        debug: { ageGroup, gender: koreanGender }
      });
    }

    // 영양 섭취 기준 데이터 매핑
    const mappedStandard = {
      연령: ageGroup,
      성별: koreanGender,
      에너지: parseFloat(standard['에너지(kcal)']) || 0,
      단백질: parseFloat(standard['단백질(g)']) || 0,
      식이섬유: parseFloat(standard['식이섬유(g)']) || 0,
      비타민A: parseFloat(standard['비타민 A(㎍ RAE)']) || 0,
      비타민C: parseFloat(standard['비타민 C(mg)']) || 0,
      티아민: parseFloat(standard['티아민(mg)']) || 0,
      리보플라빈: parseFloat(standard['리보플라빈(mg)']) || 0,
      니아신: parseFloat(standard['니아신(mg)']) || 0,
      칼슘: parseFloat(standard['칼슘(mg)']) || 0,
      나트륨: parseFloat(standard['나트륨(mg)']) || 0,
      철: parseFloat(standard['철(mg)']) || 0
    };

    res.json({ success: true, data: mappedStandard });
  } catch (error) {
    console.error('영양섭취기준 조회 오류:', error);
    res.status(500).json({
      success: false,
      error: '영양섭취기준 조회 중 오류가 발생했습니다.',
      message: error.message
    });
  }
});

// 레시피 정보 크롤링 함수, 만개의레시피 웹사이트에서 레시피 정보를 가져옴

async function foodInfo(name) {
  const url = `https://www.10000recipe.com/recipe/list.html?q=${encodeURIComponent(name)}`;
  try {
    // 레시피 목록 페이지 접근
    const response = await axios.get(url);
    const html = response.data;
    const $ = cheerio.load(html);

    const foodList = $('.common_sp_link');
    if (foodList.length === 0) {
      console.log(`'${name}'에 대한 레시피를 찾을 수 없습니다.`);
      return null;
    }

    // 첫 번째 레시피 상세 페이지 접근
    const foodId = foodList[0].attribs.href.split('/').pop();
    const newUrl = `https://www.10000recipe.com/recipe/${foodId}`;
    const newResponse = await axios.get(newUrl);
    const newHtml = newResponse.data;
    const newSoup = cheerio.load(newHtml);

    // 레시피 JSON 데이터 추출 및 파싱
    const foodInfo = newSoup('script[type="application/ld+json"]').html();
    const result = JSON.parse(foodInfo);

    // 필요한 정보만 추출하여 반환
    const ingredients = result.recipeIngredient.join(', ');
    const recipe = result.recipeInstructions.map((step, index) =>
      `${index + 1}. ${step.text}`
    );

    return {
      name: result.name,
      ingredients: ingredients,
      recipe: recipe,
    };
  } catch (error) {
    console.error('레시피 정보 크롤링 오류:', error);
    return null;
  }
}

// 레시피 검색 API, 입력받은 식품명으로 레시피 검색

app.get('/api/recipe', async (req, res) => {
  const { name } = req.query;
  const recipeInfo = await foodInfo(name);
  if (recipeInfo) {
    res.json(recipeInfo);
  } else {
    res.status(404).json({ message: "레시피를 찾을 수 없습니다." });
  }
});

// 냉장고 내 제품 목록 조회 함수, 레시피 추천에 사용할 재료 목록 반환

function getProductsFromDB() {
  return new Promise((resolve, reject) => {
    db.query('SELECT product_name FROM products', (err, results) => {
      if (err) {
        console.error('MySQL query error:', err);
        reject(err);
      } else {
        resolve(results.map(row => row.product_name));
      }
    });
  });
}

// ChatGPT를 이용한 레시피 생성 함수

async function getRecipe(ingredients) {
  const prompt = `다음 재료를 사용하여 만들 수 있는 요리와 그 조리법을 알려주세요: ${ingredients.join(', ')}`;

  try {
    const completion = await openai.chat.completions.create({
      messages: [
        {
          "role": "system",
          "content": "당신은 요리 전문가입니다. 주어진 재료로 만들 수 있는 요리와 조리법을 상세히 설명해주세요."
        },
        {
          "role": "user",
          "content": prompt
        }
      ],
      model: "gpt-3.5-turbo",
      max_tokens: 500
    });
    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error('OpenAI API error:', error);
    throw new Error('레시피 생성 중 오류가 발생했습니다.');
  }
}

// 사용 가능한 재료 목록 조회 API, 현재 냉장고에 있는 재료 목록 반환

app.get('/api/available-ingredients', async (req, res) => {
  try {
    const products = await getProductsFromDB();
    res.json(products);
  } catch (error) {
    console.error('재료 목록 조회 오류:', error);
    res.status(500).json({ error: '재료 목록을 가져오는 중 오류가 발생했습니다.' });
  }
});

// 레시피 추천 API, 선택된 재료들을 기반으로 레시피 추천

app.post('/api/recommend-recipe', async (req, res) => {
  try {
    const selectedIngredients = req.body.ingredients;
    if (!selectedIngredients || selectedIngredients.length === 0) {
      return res.status(400).json({ error: '선택된 재료가 없습니다.' });
    }

    const recipe = await getRecipe(selectedIngredients);
    res.json({ recipe });
  } catch (error) {
    console.error('레시피 추천 오류:', error);
    res.status(500).json({ error: '레시피 추천 중 오류가 발생했습니다.' });
  }
});

// 제품 목록 조회 API
app.get('/api/products', (req, res) => {
  const query = `
    SELECT 
      id, 
      product_name, 
      quantity, 
      expiration_date,
      CLS_NM_1,
      CLS_NM_2,
      CLS_NM_3,
      gtin,
      country,
      company
    FROM products 
    ORDER BY expiration_date ASC`;

  db.query(query, (err, results) => {
    if (err) {
      console.error('제품 목록 조회 오류:', err);
      res.status(500).json({ error: '데이터 조회 실패' });
    } else {
      res.json(results);
    }
  });
});

// 제품 추가 API
app.post('/api/add-product', (req, res) => {
  const {
    product_name,
    quantity,
    expiration_date,
    CLS_NM_1,
    CLS_NM_2,
    CLS_NM_3,
    gtin,
    country,
    company
  } = req.body;

  if (!product_name || !quantity || !expiration_date) {
    return res.status(400).json({ error: '필수 필드를 입력해주세요' });
  }

  const query = `
    INSERT INTO products (
      product_name, 
      quantity, 
      expiration_date,
      CLS_NM_1,
      CLS_NM_2,
      CLS_NM_3,
      gtin,
      country,
      company
    ) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  db.query(
    query,
    [
      product_name,
      quantity,
      expiration_date,
      CLS_NM_1 || null,
      CLS_NM_2 || null,
      CLS_NM_3 || null,
      gtin || null,
      country || null,
      company || null
    ],
    (err) => {
      if (err) {
        console.error('제품 추가 오류:', err);
        return res.status(500).json({ error: '제품 추가 실패' });
      }
      res.status(201).json({ message: '제품이 성공적으로 추가되었습니다' });
    }
  );
});
// 제품 수량 업데이트 API
app.put('/api/update-product/:id', (req, res) => {
  const productId = req.params.id;
  const newQuantity = parseInt(req.body.quantity);

  // 제품 수량 업데이트만 수행
  const updateQuery = `
    UPDATE products 
    SET quantity = ? 
    WHERE id = ?
  `;

  db.query(updateQuery, [Math.max(0, newQuantity), productId], (updateErr) => {
    if (updateErr) {
      console.error('제품 수량 업데이트 오류:', updateErr);
      return res.status(500).json({ error: '제품 수량 업데이트 실패' });
    }
    res.json({ message: '제품 수량이 업데이트되었습니다' });
  });
});

// 제품 삭제 API
app.delete('/api/delete-product/:id', (req, res) => {
  const productId = req.params.id;

  if (!productId || isNaN(productId)) {
    return res.status(400).json({ error: '잘못된 제품 ID입니다' });
  }

  const query = `
        DELETE FROM products 
        WHERE id = ?`;

  db.query(query, [productId], (err) => {
    if (err) {
      console.error('제품 삭제 오류:', err);
      return res.status(500).json({ error: '제품 삭제 실패' });
    }
    res.json({ message: '제품이 성공적으로 삭제되었습니다' });
  });
});

// 유통기한 임박 상품 조회 API, 30일 이내 유통기한 임박 상품 목록 반환

app.get('/api/expiration-products', (req, res) => {
  const today = new Date();
  const expirationThreshold = new Date(today);
  expirationThreshold.setDate(today.getDate() + 30);

  const query = `
    SELECT 
      id,
      product_name,
      quantity,
      DATE_FORMAT(expiration_date, '%Y-%m-%d') as expiration_date,
      DATEDIFF(expiration_date, CURDATE()) as days_remaining
    FROM products
    WHERE expiration_date IS NOT NULL
      AND expiration_date >= CURDATE()
    ORDER BY expiration_date ASC
    LIMIT 10`;

  db.query(query, (err, results) => {
    if (err) {
      console.error('유통기한 임박 상품 조회 오류:', err);
      return res.json([]); // 오류 발생시 빈 배열 반환
    }

    // 결과가 없는 경우에도 빈 배열 반환
    if (results.length === 0) {
      console.log('유통기한 임박 상품 없음');
      return res.json([]);
    }

    res.json(results);
  });
});

// 소비 기록 조회 API, 최근 1개월간의 제품 소비 기록 조회

app.get('/api/consumption', (req, res) => {
  const query = `
        SELECT 
            cl.usage_date, 
            p.product_name, 
            cl.quantity_used
        FROM consumption_logs cl
        JOIN products p ON cl.product_id = p.id
        WHERE cl.usage_date >= DATE_SUB(CURDATE(), INTERVAL 1 MONTH)
        ORDER BY cl.usage_date DESC`;

  db.query(query, (error, results) => {
    if (error) {
      console.error('소비 기록 조회 오류:', error);
      return res.status(500).json({ error: "데이터베이스 오류" });
    }
    res.json(results);
  });
});

// 쿠팡 상품 검색 API, 키워드로 쿠팡 상품 검색

app.get('/api/search-coupang', async (req, res) => {
  const { keyword } = req.query;
  if (!keyword) {
    return res.status(400).json({ error: '검색어가 필요합니다.' });
  }

  try {
    const results = await searchCoupang(keyword);
    res.json(results);
  } catch (error) {
    console.error('쿠팡 검색 오류:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// 쿠팡 상품 검색 함수, Puppeteer를 사용하여 쿠팡 웹사이트 크롤링

async function searchCoupang(keyword) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    const searchUrl = `https://www.coupang.com/np/search?component=&q=${encodeURIComponent(keyword)}`;

    await page.goto(searchUrl, {
      waitUntil: 'networkidle0',
      timeout: 60000  // 60초로 증가
    });

    try {
      await page.waitForSelector('.search-product', { timeout: 30000 });  // 30초로 증가
    } catch (error) {
      console.log('검색 결과를 찾을 수 없습니다:', error);
      return [];
    }

    // 페이지 로딩 대기
    await new Promise(resolve => setTimeout(resolve, 10000));  // 10초 대기

    // 상품 정보 추출
    const results = await page.evaluate(() => {
      const products = Array.from(document.querySelectorAll('.search-product'));
      return products.slice(0, 5).map(product => {
        const nameEl = product.querySelector('.name');
        const priceEl = product.querySelector('.price-value');
        const linkEl = product.querySelector('a.search-product-link');

        return {
          name: nameEl ? nameEl.textContent.trim() : '제품명 없음',
          price: priceEl ? priceEl.textContent.trim() + '원' : '가격 정보 없음',
          link: linkEl ? 'https://www.coupang.com' + linkEl.getAttribute('href') : '#'
        };
      }).filter(item => item.name !== '제품명 없음' && item.price !== '가격 정보 없음');
    });

    return results;
  } catch (error) {
    console.error('크롤링 오류:', error);
    throw new Error('상품 검색 중 오류가 발생했습니다.');
  } finally {
    await browser.close();
  }
}

// 프로필 업데이트 API, 사용자 프로필 정보 업데이트

app.post('/api/profile/update', async (req, res) => {
  const { age, gender } = req.body;

  try {
    // TODO: 실제 DB 저장 로직 구현
    res.json({
      success: true,
      message: '프로필이 업데이트되었습니다.',
      data: { age, gender }
    });
  } catch (error) {
    console.error('프로필 업데이트 오류:', error);
    res.status(500).json({
      success: false,
      error: '프로필 업데이트 중 오류가 발생했습니다.'
    });
  }
});

// 제품 상세 정보 조회 API, 제품명으로 상품 검색 및 알레르기 정보 조회

app.get('/api/products/details', async (req, res) => {
  const searchName = req.query.name;
  let query;
  let params;

  if (searchName) {
    query = `
            SELECT id, product_name 
            FROM products 
            WHERE product_name LIKE ?
            ORDER BY product_name ASC
        `;
    params = [`%${searchName}%`];
  } else {
    query = `
            SELECT id, product_name 
            FROM products 
            ORDER BY product_name ASC
            LIMIT 10
        `;
    params = [];
  }

  try {
    const [products] = await db.promise().query(query, params);

    // 각 제품에 대한 알레르기 정보 조회
    const detailedProducts = await Promise.all(
      products.map(async (product) => {
        try {
          const allergyInfo = await getFoodSafetyInfo(product.product_name);
          return {
            id: product.id,
            제품명: product.product_name,
            ...allergyInfo
          };
        } catch (error) {
          console.error(`알레르기 정보 조회 실패 (${product.product_name}):`, error);
          return {
            id: product.id,
            제품명: product.product_name,
            알레르기정보: '정보 없음',
            원재료명: '정보 없음',
            영양성분: '정보 없음'
          };
        }
      })
    );

    res.json({
      success: true,
      data: detailedProducts
    });
  } catch (error) {
    console.error('제품 정보 조회 오류:', error);
    res.status(500).json({
      success: false,
      error: '제품 정보 조회 중 오류가 발생했습니다.'
    });
  }
});

// 식품안전나라 API 호출 함수, 제품명으로 식품안전 정보 조회

async function getFoodSafetyInfo(productName) {
  try {
    const url = `${FOOD_API_CONFIG.baseUrl}?ServiceKey=${FOOD_API_CONFIG.serviceKey}&prdlstNm=${encodeURIComponent(productName)}`;
    const response = await axios.get(url);
    const result = await parser.parseStringPromise(response.data);

    if (!result.response?.body?.items?.item) {
      return {
        알레르기정보: '정보 없음',
        원재료명: '정보 없음',
        영양성분: '정보 없음'
      };
    }

    const item = Array.isArray(result.response.body.items.item)
      ? result.response.body.items.item[0]
      : result.response.body.items.item;

    return {
      알레르기정보: item.allergy || '정보 없음',
      원재료명: item.rawmtrl || '정보 없음',
      영양성분: item.nutrient || '정보 없음'
    };
  } catch (error) {
    console.error('식품안전나라 API 호출 오류:', error);
    throw error;
  }
}

// 서버 종료 처리 수정
process.on('SIGINT', () => {
  console.log('Shutting down...');
  wss.close(() => {
    console.log('WebSocket server closed');
    mqttClient.end(true, () => {
      server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
      });
    });
  });
});

/* 서버 시작 */
const port = 3000;
server.listen(port, '0.0.0.0', () => {
  console.log(`Server running on port ${port}`);
  startBarcodeReader(); // 여기에 바코드 스캐너 시작 추가
});