// 夹具：rc=0 但自报 2 条提醒 ⇒ verdict=pass 且 warns=2（汇总退出码 1：有提醒 ≠ 全绿）
console.log("一切通过，另有 2 条提醒由作者定夺");
console.log("WARN_COUNT=2 FAIL_COUNT=0");
process.exit(0);
