import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { once } from "node:events";

function integer(value, name, minimum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) throw new Error(`${name} must be an integer >= ${minimum}.`);
  return parsed;
}

const outputIndex = process.argv.indexOf("--out");
const rowsIndex = process.argv.indexOf("--rows");
const columnsIndex = process.argv.indexOf("--columns");
if (outputIndex < 0 || rowsIndex < 0 || columnsIndex < 0) {
  throw new Error("Usage: generate-large-csv --out <path> --rows <count> --columns <count>");
}
const output = resolve(process.argv[outputIndex + 1]);
const rows = integer(process.argv[rowsIndex + 1], "rows", 1);
const columns = integer(process.argv[columnsIndex + 1], "columns", 5);
await mkdir(dirname(output), { recursive: true });

const headers = ["Id", "Company", "Status", "Name", "OptionalComment"];
for (let index = headers.length; index < columns; index += 1) headers.push(`Column${String(index + 1).padStart(3, "0")}`);
const stream = createWriteStream(output, { encoding: "utf8", highWaterMark: 4 * 1024 * 1024 });
stream.write(`${headers.join(",")}\n`);
let buffer = "";
for (let row = 1; row <= rows; row += 1) {
  const id = String(row).padStart(12, "0");
  const values = [
    id,
    String(row % 100).padStart(2, "0"),
    row % 10 === 0 ? "Inactive" : "Active",
    `Employee ${id}`,
    row % 7 === 0 ? `Note ${row % 1000}` : ""
  ];
  for (let column = values.length; column < columns; column += 1) {
    values.push(`V${column + 1}_${row % 1000}`);
  }
  buffer += `${values.join(",")}\n`;
  if (buffer.length >= 4 * 1024 * 1024) {
    if (!stream.write(buffer)) await once(stream, "drain");
    buffer = "";
  }
}
if (buffer.length > 0) stream.write(buffer);
stream.end();
await once(stream, "finish");
console.log(JSON.stringify({ output, rows, columns }));
