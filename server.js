// 부주마켓 홍보 사이트 전용 서버 (봇/API/카톡 없음 - 홍보 페이지만 띄움)
const express = require('express');
const path = require('path');

const app = express();

// 깨우기용 헬스체크 (UptimeRobot 핑)
app.get('/health', (req, res) => res.send('OK'));

// 그 외 모든 요청 -> 부주마켓 홍보 페이지
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('부주마켓 홍보 사이트 실행 중 - 포트 ' + PORT));
