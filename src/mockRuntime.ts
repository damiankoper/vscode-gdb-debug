/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { EventEmitter } from 'events';
import Gdb from './gdb';
import * as _ from 'lodash'
import { DebugProtocol } from 'vscode-debugprotocol';

export interface MockBreakpoint {
	id: number;
	line: number;
	verified: boolean;
}

/**
 * A Mock runtime with minimal debugger functionality.
 */
export class MockRuntime extends EventEmitter {

	// maps from sourceFile to array of Mock breakpoints
	private _breakPoints = new Map<string, MockBreakpoint[]>();

	// since we want to send breakpoint events, we will assign an id to every event
	// so that the frontend can match events with breakpoints.
	private _breakpointId = 1;
	private _exceptionId = 1;
	private lastExceptionResult: any = null;

	private gdb: Gdb;
	public getGdb() {
		return this.gdb
	}

	public disableRaw = () => this.rawDisabled = true;
	public rawDisabled = false;

	constructor() {
		super();
		this.gdb = new Gdb();

		// Pipe everything to debugConsole output
		this.gdb.on('dataStream', (data: string) => {
			if (this.rawDisabled)
				this.rawDisabled = false;
			else {
				this.sendEvent('outputRaw', data);
			}
		})

		this.gdb.on('breakpointModified', (record: any) => {
			//console.log(record.class, record.result.bkpt.fullname)
			record = record.result.bkpt
			let breakpoints = this._breakPoints.get(record.fullname)
			let bp: MockBreakpoint = <MockBreakpoint>_.find(breakpoints, (bp: MockBreakpoint) => bp.id == record.number)
			if (bp) {
				bp.line = parseInt(record.line)
				bp.verified = true
				this.sendEvent('breakpointValidated', bp);
			}
		})

		this.gdb.on('stopped', (record: any) => {
			//console.log(record.result.reason)
			switch (record.result.reason) {
				case 'breakpoint-hit':
					this.sendEvent('stopOnBreakpoint')
					break;
				case 'end-stepping-range':
					this.sendEvent('stopOnStep')
					break;
				case 'exited-normally':
					this.sendEvent('end')
					break;
				case 'exited-signalled':
					this.sendEvent('end')
					break;
				case 'signal-received':
					this.lastExceptionResult = record.result;
					this.sendEvent('stopOnException', "Received signal")
					break;
			}
		})

		this.gdb.on('end', () => {
			this.sendEvent('end')
		})
	}

	public async start(program: string, stopOnEntry: boolean) {
		await this.gdb.initRegisters();

		await this.gdb.send(`file ${program}\n`)
		await this.createBreakpoints();

		if (stopOnEntry) {
			await this.gdb.send(`-break-insert _start\n`)
		}
		await new Promise(resolve =>
			setTimeout(async () => {
				await this.gdb.send(`run\n`)
				await this.gdb.send(`record\n`) //send record to init
				resolve()
			}, 10)
		)
	}

	public async reverse() {
		await this.gdb.send(`reverse-step\n`)
	}

	public async continue() {
		await this.gdb.send(`continue\n`)
	}

	public async step() {
		await this.gdb.send(`next\n`)
	}

	public async stepIn() {
		await this.gdb.send(`step\n`)
	}

	public async stack(startFrame: number, endFrame: number) {

		let resp: any = await this.gdb.send('-stack-list-frames\n');
		const frames = new Array<any>();
		resp.resultRecord.result.stack.forEach((frameObj: any) => {
			frames.push({
				index: parseInt(frameObj.level),
				name: frameObj.func,
				file: frameObj.fullname,
				line: parseInt(frameObj.line) - 1
			});
		})
		return {
			frames: frames,
			count: frames.length
		};
	}

	public async setBreakPoint(path: string, line: number): Promise<MockBreakpoint> {
		const bp = <MockBreakpoint>{ verified: false, line, id: this._breakpointId++ };
		let bps = this._breakPoints.get(path);
		if (!bps) {
			bps = new Array<MockBreakpoint>();
			this._breakPoints.set(path, bps);
		}
		bps.push(bp);

		return bp;
	}

	public async createBreakpoints() {
		for (let [path, bps] of this._breakPoints) {
			for (const bp of bps) {
				await this.gdb.send(`-break-insert ${path}:${bp.line + 1}\n`)
			}
		}

	}

	public async clearBreakpoints(path: string) {
		let fileBreakpoints = this._breakPoints.get(path)
		if (fileBreakpoints) {
			for (const bp of fileBreakpoints) {
				await this.gdb.send(`-break-delete ${bp.id}\n`)
			}
		}
		this._breakPoints.delete(path);
	}

	private async sendEvent(event: string, ...args: any[]) {
		await setImmediate(_ => {
			this.emit(event, ...args);
		});
	}

	public async evaluateExpression(args: DebugProtocol.EvaluateArguments) {
		let exp = args.expression
		// if register
		if (this.gdb.isRegister(exp)) {
			return (await this.gdb.getRegisterValues([exp]))[exp]
		}
		// if examine memory
		else if (exp.trim().startsWith('-x')) {
			exp = exp.trim().slice(2).trim();
			let result = ""
			let record: any = await this.gdb.send(`-data-read-memory ${exp}\n`)
			if (record.resultRecord.class === 'done') {
				record.resultRecord.result.memory.forEach(row => {
					let cols = row.data.join(' ')
					result += `${row.addr}: ${cols}`
				})
			}
			console.log(result);
			return result
		}
		// if print expresion
		else if (exp.trim().startsWith('-p')) {
			exp = exp.trim().slice(2).trim()
			let record: any = await this.gdb.send(`-data-evaluate-expression "${exp}"\n`)
			return record.resultRecord.result.value;
		}
		// if raw
		else {
			return await this.gdb.sendGetOutputString(`${exp}\n`)
		}
	}

	// todo: useless for now
	public getLastException() {
		this.lastExceptionResult;
		return {
			exceptionId: "" + this._exceptionId++,
			breakMode: <DebugProtocol.ExceptionBreakMode>'unhandled',
			description: this.lastExceptionResult['signal-name'],
			details: {
				message: this.lastExceptionResult['signal-meaning'] + '. Core ' + this.lastExceptionResult['core'] + '.'
			}
		}
	}
}