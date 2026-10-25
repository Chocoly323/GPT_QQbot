// QQ scheduled offline window: [01:00, 07:00), Asia/Shanghai.
export function isQQOfflineTime(now = new Date()) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23',
  }).format(now));
  return hour >= 1 && hour < 7;
}
