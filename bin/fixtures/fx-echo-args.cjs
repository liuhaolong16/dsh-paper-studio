// 夹具：把收到的参数原样打出（锁"声明的输入必须真的传给门"）
console.log("ARGV=" + process.argv.slice(2).join(" "));
process.exit(0);
