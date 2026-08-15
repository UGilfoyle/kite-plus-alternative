// NSE/BSE session helpers. Holiday-specific closures are inferred from candle data.
(function () {
  const IST_OFFSET_MINUTES = 330;

  function istParts(date = new Date()) {
    const utc = date.getTime() + date.getTimezoneOffset() * 60000;
    const ist = new Date(utc + IST_OFFSET_MINUTES * 60000);
    return {
      year: ist.getFullYear(),
      month: ist.getMonth(),
      date: ist.getDate(),
      day: ist.getDay(),
      hour: ist.getHours(),
      minute: ist.getMinutes()
    };
  }

  function isTradingDay(date = new Date()) {
    const { day } = istParts(date);
    return day !== 0 && day !== 6;
  }

  function isMarketOpen(date = new Date()) {
    if (!isTradingDay(date)) return false;
    const { hour, minute } = istParts(date);
    const minutes = hour * 60 + minute;
    return minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
  }

  function tradingDaysBetween(startMs, endMs) {
    if (!startMs || !endMs || endMs <= startMs) return 0;
    let count = 0;
    const cursor = new Date(startMs);
    cursor.setUTCHours(0, 0, 0, 0);
    const end = new Date(endMs);
    end.setUTCHours(0, 0, 0, 0);
    while (cursor < end) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      if (isTradingDay(cursor)) count++;
    }
    return count;
  }

  function nextTradingDay(fromMs = Date.now(), days = 1) {
    const cursor = new Date(fromMs);
    let remaining = Math.max(1, Number(days) || 1);
    while (remaining > 0) {
      cursor.setDate(cursor.getDate() + 1);
      if (isTradingDay(cursor)) remaining--;
    }
    return cursor.getTime();
  }

  window.KPMarketSession = {
    istParts,
    isTradingDay,
    isMarketOpen,
    tradingDaysBetween,
    nextTradingDay
  };
})();
