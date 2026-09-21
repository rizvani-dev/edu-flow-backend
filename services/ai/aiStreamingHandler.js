const writeSseHeaders = (res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
};

const sendSse = (res, event, data) => {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
};

const closeSse = (res) => {
  sendSse(res, 'done', { success: true });
  res.end();
};

module.exports = {
  closeSse,
  sendSse,
  writeSseHeaders,
};
