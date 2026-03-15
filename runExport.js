import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import _ from "lodash";
import dayjs from "dayjs";
import axios from "axios";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
dayjs.extend(utc);
dayjs.extend(timezone);

async function getDrawsByDate({ cnDate }) {
  try {
    const response = await axios.get(`https://jnd.cc.cd/api/kenoDraw`, {
      params: {
        date: cnDate, 
        debug: 1,
      },
    });

    console.log("获取到的数据:", response?.data?.list?.length);
    return _.get(response,'data.list',[]);
  } catch (error) {
    console.error("获取数据失败:", error);
    return [];
  }
}

async function exportHistoryData() {
  const CSV_FILE = path.resolve(process.cwd(), "historyDraw.csv");
  const headers = [
    "drawNbr",
    "chinaLotteryTime",
    "drawResult",
    "calcResult",
    "ds",
    "dx",
    "zh",
    "shape",
    "extreme",
    "drawNbrs",
  ];

  const existingDraws = new Set();
  let startDateStr = "2025-01-01";
  let lastDrawDate = null;

  if (fs.existsSync(CSV_FILE)) {
    const content = fs.readFileSync(CSV_FILE, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    // Skip header
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",");
      if (cols[0]) existingDraws.add(Number(cols[0]));
      // chinaLotteryTime is index 1
      if (cols[1]) {
        // Just keep updating, the last one will be the latest if file is appended sequentially
        // Format is YYYY-MM-DD HH:mm:ss
        const datePart = cols[1].split(" ")[0];
        if (datePart) lastDrawDate = datePart;
      }
    }
    console.log(
      `Found ${existingDraws.size} existing draws in historyDraw.csv`,
    );

    if (lastDrawDate) {
      // Start from the date of the last record to fill in any missing draws for that day
      startDateStr = lastDrawDate;
      console.log(`Resuming from ${startDateStr} (based on last record)`);
    }
  } else {
    fs.writeFileSync(CSV_FILE, headers.join(",") + "\n");
    console.log("Created new historyDraw.csv");
  }

  // 确保开始日期有效
  const today = dayjs().tz("Asia/Shanghai");
  let current = dayjs.tz(startDateStr, "Asia/Shanghai");

  // 如果开始日期比今天还晚，说明有问题，或者是未来时间（可能是时区导致的边界情况）
  // 但一般我们至少要检查今天的数据
  if (current.isAfter(today)) {
    current = today;
  }

  // Helper to format CSV line
  const toCSV = (item) => {
    return [
      item.drawNbr,
      item.chinaLotteryTime,
      item.drawResult,
      item.calcResult.join("|"),
      item.ds,
      item.dx,
      item.zh,
      item.shape,
      item.extreme,
      item.drawNbrs.join("|"),
    ].join(",");
  };

  while (current.isBefore(today) || current.isSame(today, "day")) {
    const dateStr = current.format("YYYY-MM-DD");

    // 如果是今天，或者是重新开始检查的日期（start date），我们强制fetch
    // 否则，如果是历史日期，并且已经有足够的数据量（比如 > 400），可以跳过
    // 但为了确保万无一失（比如某天只有300期），我们还是默认检查
    // 除非我们添加逻辑去统计每一天在CSV中的行数。

    // 简单优化：统计 CSV 中该日期的条数，如果 > 400，跳过
    let countForDate = 0;

    // 如果日期不是今天，我们可以尝试跳过
    if (dateStr !== today.format("YYYY-MM-DD")) {
      // 这里如果想优化，可以在一开始读取CSV时就统计每天的记录数
      // 但现在我们只记录了 existingDraws Set
      // 既然用户要求"查询从最新一期开始补齐当天的"，那么对于历史数据（除了最后一天），如果已经完整了其实没必要再查
      // 但是我们不知道某一天是否完整，除非我们去统计
    }

    // 重试机制
    let retries = 3;
    let success = false;

    while (retries > 0 && !success) {
      try {
        if (retries < 3) console.log(`Retry ${3 - retries} for ${dateStr}...`);

        console.log(`Fetching data for ${dateStr}...`);
        const data = await getDrawsByDate({ cnDate: dateStr });

        let newCount = 0;
        const linesToAppend = [];

        // Sort data by drawNbr just in case
        const sortedData = _.sortBy(data, "drawNbr");

        for (const item of sortedData) {
          if (!existingDraws.has(Number(item.drawNbr))) {
            linesToAppend.push(toCSV(item));
            existingDraws.add(Number(item.drawNbr));
            newCount++;
          }
        }

        if (linesToAppend.length > 0) {
          fs.appendFileSync(CSV_FILE, linesToAppend.join("\n") + "\n");
          console.log(`Saved ${newCount} new draws for ${dateStr}`);
        } else {
          console.log(`No new draws for ${dateStr} (Already up to date)`);
        }
        success = true;
      } catch (e) {
        retries--;
        const isNetworkError =
          e.message &&
          (e.message.includes("stream has been aborted") ||
            e.message.includes("socket hang up") ||
            e.message.includes("timeout") ||
            e.message.includes("ECONNRESET"));

        if (isNetworkError) {
          console.log(
            `Network issue for ${dateStr}: ${e.message}. Remaining retries: ${retries}`,
          );
          if (retries > 0)
            await new Promise((resolve) => setTimeout(resolve, 2000)); // wait 2s
        } else {
          console.error(`Error processing ${dateStr}:`, e.message);
          // Non-network error, maybe break retry? but let's just continue
        }
      }
    }

    current = current.add(1, "day");
  }

  console.log("Export completed.");
}

exportHistoryData()
  .then(() => {
    console.log("Done.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Failed:", err);
    process.exit(1);
  });
