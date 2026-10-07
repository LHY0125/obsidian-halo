import { readFileSync, writeFileSync } from "node:fs";

const targetVersion = process.env.npm_package_version;

/**
 * 写回 JSON 时**保留各文件自己的缩进风格**，并补末尾换行。
 *
 * 此前两个文件都用 `JSON.stringify(x, null, "\t")` 写回，有两个问题：
 *
 * ① **`manifest.json` 被从 2 空格改成 tab** —— 仓库里它本来是 2 空格（上游也是），
 *    每次发版都会产生一整片「只有缩进变了」的 diff，把真正的一行版本号改动淹掉。
 *    `versions.json` 本来就是 tab，所以只对它保持 tab。
 * ② **末尾换行被吃掉**（`JSON.stringify` 不产出 `\n`）—— 每次发版都会带上
 *    「\ No newline at end of file」这条 diff 噪声，POSIX 文本文件约定要求有末尾换行。
 *
 * 判据取**文件原本的缩进**（读进来先看第一行缩进是 tab 还是空格），而不是写死 ——
 * 这样将来谁改了风格，脚本跟着走，不需要再改这里。
 */
function indentOf(text) {
  const line = text.split("\n").find((l) => /^\s+"|^\s+\S/.test(l) && !/^\s*[{}[\]]/.test(l));
  return line && line.startsWith("\t") ? "\t" : 2;
}

function writeJsonPreservingStyle(path, data) {
  const original = readFileSync(path, "utf8");
  writeFileSync(path, JSON.stringify(data, null, indentOf(original)) + "\n");
}

// read minAppVersion from manifest.json and bump version to target version
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeJsonPreservingStyle("manifest.json", manifest);

// update versions.json with target version and minAppVersion from manifest.json
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeJsonPreservingStyle("versions.json", versions);
