import { crc32, deflateSync } from "node:zlib";

/**
 * The suite's media fixtures, drawn here in code rather than committed as
 * files: a red square (also as a JPEG labelled PNG), a one-page PDF with a
 * code word, a corrupt PDF, and a short tone.
 * Self-made, so they hold no personal data; each case asserts that the model
 * saw the part it can check (the colour, the code word), never its wording.
 */

const chunk = (type: string, data: Buffer) => {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
	return Buffer.concat([length, Buffer.from(type), data, crc]);
};

/** A solid square as a PNG, 8-bit RGB. */
function square(size: number, [r, g, b]: [number, number, number]): Buffer {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header.set([8, 2, 0, 0, 0], 8);
	const row = Buffer.alloc(1 + size * 3);
	for (let x = 0; x < size; x++) row.set([r, g, b], 1 + x * 3);
	const pixels = Buffer.concat(Array.from({ length: size }, () => row));
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(pixels)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/** A one-page PDF that says `text` in Helvetica, with a correct cross-reference table. */
function pdf(text: string): Buffer {
	const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let body = "%PDF-1.4\n";
	const offsets = objects.map((object, index) => {
		const offset = body.length;
		body += `${index + 1} 0 obj\n${object}\nendobj\n`;
		return offset;
	});
	const xref = body.length;
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets)
		body += `${String(offset).padStart(10, "0")} 00000 n \n`;
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(body, "latin1");
}

/** A sine tone as 16-bit mono PCM WAV. */
function tone(seconds: number, hertz: number, rate = 16_000): Buffer {
	const samples = Math.round(seconds * rate);
	const data = Buffer.alloc(samples * 2);
	for (let i = 0; i < samples; i++) {
		data.writeInt16LE(
			Math.round(Math.sin((2 * Math.PI * hertz * i) / rate) * 12_000),
			i * 2,
		);
	}
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + data.length, 4);
	header.write("WAVEfmt ", 8);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(rate, 24);
	header.writeUInt32LE(rate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(data.length, 40);
	return Buffer.concat([header, data]);
}

/**
 * A solid square as a baseline JPEG, 4:4:4, every quantiser 1. A solid
 * colour has only DC coefficients, the same in every block, so the scan is
 * one DC difference per component in the first block and zeros after it,
 * coded with two tiny Huffman tables of the file's own.
 */
function jpegSquare(size: number, [r, g, b]: [number, number, number]): Buffer {
	const segment = (marker: number, data: number[]) =>
		Buffer.from([
			0xff,
			marker,
			(data.length + 2) >> 8,
			(data.length + 2) & 0xff,
			...data,
		]);
	const levels = [
		0.299 * r + 0.587 * g + 0.114 * b,
		-0.1687 * r - 0.3313 * g + 0.5 * b + 128,
		0.5 * r - 0.4187 * g - 0.0813 * b + 128,
	];
	// DC of a constant 8×8 block is 8 × (level − 128) with unit quantisers.
	const dcs = levels.map((level) => 8 * Math.round(level - 128));
	const category = (value: number) =>
		value === 0 ? 0 : Math.floor(Math.log2(Math.abs(value))) + 1;
	const categories = [...new Set([0, ...dcs.map(category)])].sort(
		(x, y) => x - y,
	);
	// Every DC category gets a 4-bit code, in order; the AC table holds only end-of-block, code 0.
	const dcCode = (cat: number) => ({
		code: categories.indexOf(cat),
		length: 4,
	});
	let bits = "";
	const put = (value: number, length: number) => {
		bits += length > 0 ? value.toString(2).padStart(length, "0") : "";
	};
	const blocks = (size / 8) ** 2;
	for (let block = 0; block < blocks; block++) {
		for (const dc of dcs) {
			const diff = block === 0 ? dc : 0;
			const cat = category(diff);
			const { code, length } = dcCode(cat);
			put(code, length);
			put(diff >= 0 ? diff : diff + (1 << cat) - 1, cat);
			put(0, 1); // end of block
		}
	}
	bits = bits.padEnd(Math.ceil(bits.length / 8) * 8, "1");
	const scan: number[] = [];
	for (let i = 0; i < bits.length; i += 8) {
		const byte = Number.parseInt(bits.slice(i, i + 8), 2);
		scan.push(byte);
		if (byte === 0xff) scan.push(0x00);
	}
	const counts = (lengths: number[]) =>
		Array.from(
			{ length: 16 },
			(_, i) => lengths.filter((length) => length === i + 1).length,
		);
	return Buffer.concat([
		Buffer.from([0xff, 0xd8]),
		segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
		segment(0xdb, [0x00, ...Array(64).fill(1)]),
		segment(0xc0, [
			8,
			size >> 8,
			size & 0xff,
			size >> 8,
			size & 0xff,
			3,
			1,
			0x11,
			0,
			2,
			0x11,
			0,
			3,
			0x11,
			0,
		]),
		segment(0xc4, [
			0x00,
			...counts(categories.map(() => 4)),
			...categories,
			0x10,
			...counts([1]),
			0x00,
		]),
		segment(0xda, [3, 1, 0x00, 2, 0x00, 3, 0x00, 0, 63, 0]),
		Buffer.from(scan),
		Buffer.from([0xff, 0xd9]),
	]);
}

/** A file that starts like a PDF and is not one: no objects, no cross-reference table. */
const corruptPdf = Buffer.concat([
	Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R"),
	Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 73 + 41) % 256)),
]);

/** The code word printed in the PDF fixture. */
export const codeWord = "PELICAN";

export const fixtures = {
	redSquare: `data:image/png;base64,${square(64, [220, 30, 30]).toString("base64")}`,
	pdf: `data:application/pdf;base64,${pdf(`The code word is ${codeWord}.`).toString("base64")}`,
	/** A red JPEG labelled as a PNG, as a client that guesses the type from the file name sends it. */
	jpegAsPng: `data:image/png;base64,${jpegSquare(64, [220, 30, 30]).toString("base64")}`,
	corruptPdf: `data:application/pdf;base64,${corruptPdf.toString("base64")}`,
	/** Raw base64, as `input_audio.data` takes it. */
	toneWav: tone(1, 440).toString("base64"),
};

/**
 * A public image for the image-by-URL cases: the web-platform-tests' red
 * rectangle at a fixed commit on GitHub, so it cannot change. (Wikimedia
 * Commons, the first host, refuses clients by user agent and now and then
 * Mistral's fetcher, and its redirect is disallowed in robots.txt: that
 * measured Wikimedia, not the router.)
 */
const wpt = {
	repo: "web-platform-tests/wpt",
	commit: "16cc3039191861e50cb55b9d3a97f0b2b883c36f",
};
export const redSquareUrl = `https://raw.githubusercontent.com/${wpt.repo}/${wpt.commit}/images/red.png`;

/**
 * The same image with the query string of a presigned storage URL, which
 * the file server ignores; a fetcher that drops or mangles the query, or
 * gives up on a long URL, fails it.
 */
export const redSquareSignedUrl = `${redSquareUrl}?${new URLSearchParams({
	"X-Amz-Algorithm": "AWS4-HMAC-SHA256",
	"X-Amz-Credential": "conformance/20261031/eu-central-1/s3/aws4_request",
	"X-Amz-Date": "20261031T000000Z",
	"X-Amz-Expires": "3600",
	"X-Amz-SignedHeaders": "host",
	"X-Amz-Signature": "0".repeat(64),
})}`;

/**
 * The same image behind a redirect: raw.github.com answers 301 to
 * raw.githubusercontent.com. Both hosts allow every path in robots.txt, which
 * Anthropic's fetcher obeys (github.com's `/raw/` links are disallowed).
 */
export const redSquareRedirectUrl = `https://raw.github.com/${wpt.repo}/${wpt.commit}/images/red.png`;

/**
 * A public PDF for the PDF-by-URL cases: pdf.js's example, one page that
 * reads "Hello, world!", at a release tag so it cannot change. (The W3C's
 * test PDF answers OpenRouter's fetcher with a 403.)
 */
export const helloPdfUrl =
	"https://raw.githubusercontent.com/mozilla/pdf.js/v6.4.299/examples/learning/helloworld.pdf";
export const helloPdfWord = "world";
