import { createReadStream } from "node:fs";

export interface CsvPhysicalOptions {
  delimiter: string;
  quote: string;
  allowBlankRows: boolean;
}

export interface CsvRecord {
  fields: string[];
  recordNumber: number;
}

export interface CsvStreamProgress {
  bytesRead: number;
  recordsRead: number;
}

export interface CsvStreamOptions {
  maxRecords?: number;
  progressInterval?: number;
  onProgress?: (progress: CsvStreamProgress) => void;
}

class CsvChunkParser {
  private row: string[] = [];
  private field = "";
  private inQuotes = false;
  private quotePending = false;
  private pendingCarriageReturn = false;
  private emittedRecords = 0;

  public constructor(
    private readonly delimiter: string,
    private readonly quote: string
  ) {}

  public push(chunk: string): string[][] {
    const records: string[][] = [];
    for (const character of chunk) {
      this.consume(character, records);
    }
    return records;
  }

  public finish(): string[][] {
    const records: string[][] = [];
    if (this.quotePending) {
      this.quotePending = false;
      this.inQuotes = false;
    }
    if (this.inQuotes) {
      throw new Error(`CSV record ${this.emittedRecords + 1} has an unterminated quoted field.`);
    }
    if (this.pendingCarriageReturn) {
      this.pendingCarriageReturn = false;
      this.emit(records);
    } else if (this.field.length > 0 || this.row.length > 0) {
      this.emit(records);
    }
    return records;
  }

  private consume(character: string, records: string[][]): void {
    if (this.inQuotes) {
      if (this.quotePending) {
        if (character === this.quote) {
          this.field += this.quote;
          this.quotePending = false;
          return;
        }
        this.quotePending = false;
        this.inQuotes = false;
      } else if (character === this.quote) {
        this.quotePending = true;
        return;
      } else {
        this.field += character;
        return;
      }
    }

    if (this.pendingCarriageReturn) {
      this.pendingCarriageReturn = false;
      this.emit(records);
      if (character === "\n") return;
    }

    if (character === this.delimiter) {
      this.row.push(this.field);
      this.field = "";
    } else if (character === this.quote && this.field.length === 0) {
      this.inQuotes = true;
    } else if (character === "\n") {
      this.emit(records);
    } else if (character === "\r") {
      this.pendingCarriageReturn = true;
    } else {
      this.field += character;
    }
  }

  private emit(records: string[][]): void {
    this.row.push(this.field);
    records.push(this.row);
    this.row = [];
    this.field = "";
    this.emittedRecords += 1;
  }
}

export async function* readCsvRecords(
  filePath: string,
  physical: CsvPhysicalOptions,
  options: CsvStreamOptions = {}
): AsyncGenerator<CsvRecord, CsvStreamProgress> {
  if ([...physical.delimiter].length !== 1 || [...physical.quote].length !== 1) {
    throw new Error("Streaming CSV validation requires one-character delimiter and quote values.");
  }
  const stream = createReadStream(filePath, { encoding: "utf8", highWaterMark: 1024 * 1024 });
  const parser = new CsvChunkParser(physical.delimiter, physical.quote);
  let recordNumber = 0;
  let acceptedRecords = 0;
  let lastProgress = 0;
  const maxRecords = options.maxRecords ?? Number.POSITIVE_INFINITY;
  try {
    for await (const chunk of stream) {
      for (const fields of parser.push(chunk)) {
        recordNumber += 1;
        if (!physical.allowBlankRows && fields.length === 1 && fields[0].trim().length === 0) continue;
        acceptedRecords += 1;
        if (acceptedRecords === 1 && fields[0].charCodeAt(0) === 0xfeff) {
          fields[0] = fields[0].slice(1);
        }
        yield { fields, recordNumber };
        if (acceptedRecords >= maxRecords) {
          return { bytesRead: stream.bytesRead, recordsRead: acceptedRecords };
        }
        const interval = options.progressInterval ?? 0;
        if (interval > 0 && acceptedRecords - lastProgress >= interval) {
          lastProgress = acceptedRecords;
          options.onProgress?.({ bytesRead: stream.bytesRead, recordsRead: acceptedRecords });
        }
      }
    }
    for (const fields of parser.finish()) {
      recordNumber += 1;
      if (!physical.allowBlankRows && fields.length === 1 && fields[0].trim().length === 0) continue;
      acceptedRecords += 1;
      if (acceptedRecords === 1 && fields[0].charCodeAt(0) === 0xfeff) fields[0] = fields[0].slice(1);
      yield { fields, recordNumber };
    }
    return { bytesRead: stream.bytesRead, recordsRead: acceptedRecords };
  } finally {
    stream.destroy();
  }
}
