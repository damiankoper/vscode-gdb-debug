import * as childProcess from 'child_process'
import { EventEmitter } from 'events';
import * as stream from 'stream';
import * as parseGdbMiOut from 'gdb-mi-parser'
import * as _ from 'lodash'
import * as async from 'async'
export default class Gdb extends EventEmitter {
	private gdb: childProcess.ChildProcess;

	private stdOutErrPassThrough_1: stream.PassThrough
	private stdOutErrPassThrough_2: stream.PassThrough

	public disableRaw = () => this.rawDisabled = true;
	public rawDisabled = false;

	private registers: string[] = [];

	private queue = async.queue(async (command: string, callback: (result: string) => void) => {
		this.gdb.stdin.write(command)
		let resp = await this.getGdbResponse()
		callback(resp)
	}, 1);

	constructor() {
		super()
		this.gdb = childProcess.spawn('gdb', ['-q', '--interpreter', 'mi'])
		this.gdb.stdout.setEncoding('utf8')
		this.gdb.stderr.setEncoding('utf8')

		// Clone stream (pipe to passThrough)
		this.stdOutErrPassThrough_1 = new stream.PassThrough()
		this.stdOutErrPassThrough_1.setEncoding('utf8')

		this.stdOutErrPassThrough_2 = new stream.PassThrough()
		this.stdOutErrPassThrough_2.setEncoding('utf8')

		this.gdb.stdout.pipe(this.stdOutErrPassThrough_1)
		this.gdb.stderr.pipe(this.stdOutErrPassThrough_1)

		this.gdb.stdout.pipe(this.stdOutErrPassThrough_2)
		this.gdb.stderr.pipe(this.stdOutErrPassThrough_2)

		this.stdOutErrPassThrough_2.on('data', (data: string) => {
			let splitted = data.split(/(\(gdb\))/g)
			if (splitted)
				splitted.forEach(chunk => {
					let parsed = parseGdbMiOut(chunk)
					parsed.outOfBandRecords.map(((x: any) => {
						if (x.recordType === 'stream') {
							if (x.outputType === 'log')
								return '(gdb) ' + x.result
							return x.result
						}
					})).filter((x: string | undefined) => x).forEach((str: string) => {
						this.emit('dataStream', str)
						if (str.includes('No more reverse-execution history'))
							this.emit('end')
					});
					if (parsed.resultRecord && parsed.resultRecord.type === "stream")
						this.emit('dataStream', parsed.resultRecord.result)

					parsed.outOfBandRecords.forEach((record: any) => {
						switch (record.class) {
							case 'breakpoint-created':
								this.emit('breakpointModified', record)
								break;
							case 'breakpoint-modified':
								this.emit('breakpointModified', record)
								break;
							case 'stopped':
								this.emit('stopped', record)
								break;
							// and more to come
						}
					})
				});
		})
	}

	public async send(command: string): Promise<string> {
		return new Promise((resolve: (val: string) => void) => {
			this.queue.push(command, async (resp: string) => {
				resolve(resp);
			})
		})
	}

	public async sendGetOutputString(command: string): Promise<string> {
		let record: any = await this.send(command)
		return record.outOfBandRecords.map(((x: any) => {
			if (x.recordType === 'stream' && x.outputType === 'console') {
				return x.result
			}
		})).filter((x: string | undefined) => x).join('')
	}

	private async getGdbResponse(): Promise<any> {
		return new Promise((res, rev) => {
			this.stdOutErrPassThrough_1.once('data', (data: string) => {
				let parsed = parseGdbMiOut(data)
				res(parsed)
			})
		})
	}

	public async initRegisters() {
		let resultRecord: any = await this.send('-data-list-register-names\n')
		if (resultRecord.resultRecord && resultRecord.resultRecord.class === 'done')
			this.registers = resultRecord.resultRecord.result['register-names']
	}

	public async getRegisterValues(registers: string[] = []) {
		if (registers.length === 0) {
			registers = this.registers.filter(r => r)
		}
		let numbers: number[] = [];
		numbers = registers.map(reg => {
			return this.registers.indexOf(reg);
		});
		let result: any = {}
		let values: any = await this.send(`-data-list-register-values x ${numbers.join(' ')}\n`)
		if (values && values.resultRecord && values.resultRecord.class === 'done')
			values.resultRecord.result['register-values'].forEach(data => {
				result[this.registers[data.number]] = data.value
			});

		return result;
	}

	public isRegister(reg: string) {
		return this.registers.find((v) => v === reg)
	}
}