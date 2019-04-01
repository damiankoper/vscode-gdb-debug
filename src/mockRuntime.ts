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

	private running: boolean = false
	public isRunning() {
		return this.running
	}

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
			this.verifyBreakpoint(record);
		})

		this.gdb.on('stopped', (record: any) => {
			switch (record.result.reason) {

				case 'breakpoint-hit':
					this.sendEvent('stopOnBreakpoint')
					break;
				case 'syscall-entry':
				case 'end-stepping-range':
					this.sendEvent('stopOnStep')
					break;
				case 'exited-signalled':
				case 'exited-normally':
					this.sendEvent('end')
					break;
				case 'signal-received':
					this.lastExceptionResult = record.result;
					this.sendEvent('stopOnException', "Received signal")
					break;
			}
		})

		this.gdb.on('end', () => {
			setTimeout(() => {
				this.sendEvent('end')
			}, 1000);
		})
	}

	public async start(program: string, stopOnEntry: boolean, args?: string) {

		await this.gdb.initRegisters();
		await this.gdb.send(`-file-exec-and-symbols ${program}\n`)
		//await this.gdb.send(`-interpreter-exec console "catch syscall"\n`)
		await this.createBreakpoints();

		if (args)
			await this.gdb.send(`-exec-arguments ${args}\n`)

		if (stopOnEntry)
			await this.gdb.send(`-interpreter-exec console "starti"\n`)
		else
			await this.gdb.send(`-exec-run\n`)

		//await this.gdb.send(`record\n`)

		this.running = true
		return
	}

	public async reverse() {
		await this.gdb.send(`-exec-step --reverse\n`)
	}

	public async continue() {
		await this.gdb.send(`-exec-continue\n`)
	}

	public async step() {
		await this.gdb.send(`-exec-next\n`)
	}

	public async stepIn() {
		await this.gdb.send(`-exec-step\n`)
	}

	public async stack(startFrame: number, endFrame: number) {

		let resp: any = await this.gdb.send('-stack-list-frames\n');
		const frames = new Array<any>();
		resp.resultRecord.result.stack.forEach((frameObj: any) => {
			frames.push({
				index: parseInt(frameObj.level),
				name: frameObj.func,
				file: frameObj.fullname || 'unknown',
				line: parseInt(frameObj.line) || 'unknown'
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

	public async createBreakpoints(path: any = undefined) {

		let bps = this._breakPoints.get(path);
		if (bps)
			for (const bp of bps) {
				let record: any = await this.gdb.send(`-break-insert ${path}${bp.line ? ':' + (bp.line) : ''}\n`)
				if (record.resultRecord.class === 'error') {
					this._breakpointId--
				} else {
					this.verifyBreakpoint(record.resultRecord)
				}
			}
		else
			for (let [path, bps] of this._breakPoints) {
				for (const bp of bps) {
					let record: any = await this.gdb.send(`-break-insert ${path}${bp.line ? ':' + (bp.line) : ''}\n`)
					if (record.resultRecord.class === 'error') {
						this._breakpointId--
					} else {
						this.verifyBreakpoint(record.resultRecord)
					}
				}
			}
		return
	}

	public async clearBreakpoints(path: string) {
		let record: any = await this.gdb.send(`-break-list\n`)
		let numbers = record.resultRecord.result.BreakpointTable.body.map(bkpt => {
			if (bkpt.fullname == path)
				return parseInt(bkpt.number)
		}).filter(x => x)

		for (const num of numbers) {
			await this.gdb.send(`-break-delete ${num}\n`)
		}


		this._breakPoints.delete(path);
		return
	}

	public verifyBreakpoint(record: any) {
		record = record.result.bkpt
		setTimeout(() => {
			this.sendEvent('breakpointValidated', {
				verified: true,
				line: parseInt(record.line),
				id: parseInt(record.number)
			})
		}, 250);
	}

	private async sendEvent(event: string, ...args: any[]) {
		return new Promise(res => {
			setImmediate(_ => {
				this.emit(event, ...args);
				res();
			});
		})
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
					result += `${row.addr}: ${cols} \n`
				})
			}
			return result || "error"
		}
		// if print expresion
		else if (exp.trim().startsWith('-p')) {
			exp = exp.trim().slice(2).trim()
			let record: any = await this.gdb.send(`-data-evaluate-expression "${exp}"\n`)
			if (record.resultRecord.class === 'done') {
				return record.resultRecord.result.value;
			}
			return 'error'
		}
		// if raw
		else {
			this.gdb.sendRaw(`${exp}\n`)
			return "Output:"
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