/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { readFileSync } from 'fs';
import { EventEmitter } from 'events';
import * as childProcess from 'child_process';
import * as stream from 'stream'

export interface MockBreakpoint {
	id: number;
	line: number;
	verified: boolean;
}

/**
 * A Mock runtime with minimal debugger functionality.
 */
export class MockRuntime extends EventEmitter {

	// the initial (and one and only) file we are 'debugging'
	private _sourceFiles: string[];
	public get sourceFiles() {
		return this._sourceFiles;
	}

	// the contents (= lines) of the one and only file
	private _sourceLines = new Map<string, string[]>();

	// This is the next line that will be 'executed'
	private _currentLine = 0;

	// maps from sourceFile to array of Mock breakpoints
	private _breakPoints = new Map<string, MockBreakpoint[]>();

	// since we want to send breakpoint events, we will assign an id to every event
	// so that the frontend can match events with breakpoints.
	private _breakpointId = 1;

	private gdb: childProcess.ChildProcess;
	private stdOutErrPassThrough: stream.PassThrough
	private stdOutErrPassThroughRaw: stream.PassThrough

	public disableRaw = () => this.rawDisabled = true;
	public rawDisabled = false;

	constructor() {
		super();
		this.gdb = childProcess.spawn("gdb", ['-q'])
		this.gdb.stdout.setEncoding('utf8')
		this.gdb.stderr.setEncoding('utf8')

		// Clone stream (pipe to passThrough)
		this.stdOutErrPassThrough = new stream.PassThrough()
		this.stdOutErrPassThrough.setEncoding('utf8')

		this.stdOutErrPassThroughRaw = new stream.PassThrough()
		this.stdOutErrPassThroughRaw.setEncoding('utf8')

		this.gdb.stdout.pipe(this.stdOutErrPassThrough)
		this.gdb.stderr.pipe(this.stdOutErrPassThrough)

		this.gdb.stdout.pipe(this.stdOutErrPassThroughRaw)
		this.gdb.stderr.pipe(this.stdOutErrPassThroughRaw)

		// Pipe everything to debugConsole output
		this.stdOutErrPassThroughRaw.on('data', (data: string) => {
			if (this.rawDisabled)
				this.rawDisabled = false;
			else {
				data = data.replace(/\(gdb\)/ig, '')
				data = data.trim()
				this.sendEvent('outputRaw', data);
			}
		})


	}

	private async getGdbResponse(): Promise<string> {
		return new Promise((res, rev) => {
			this.stdOutErrPassThrough.once('data', (data: string) => {
				data = data.replace(/\(gdb\)/ig, '')
				data = data.trim()
				res(data)
			})
		})
	}

	public async sendToGdb(command: string): Promise<string> {
		this.gdb.stdin.write(command)
		return await this.getGdbResponse();
	}

	/**
	 * Start executing the given program.
	 */
	public async start(program: string, stopOnEntry: boolean) {

		await this.sendToGdb(`file ${program}\n`)
		let sources = <string>await this.sendToGdb(`info sources\n`)
		this.loadSources(sources);

		this._currentLine = -1;

		/*


		if (stopOnEntry) {
			// we step once
			this.step(false, 'stopOnEntry');
		} else {
			// we just start to run until we hit a breakpoint or an exception
			this.continue();
		} */

	}

	/**
	 * Continue execution to the end/beginning.
	 */
	public continue(reverse = false) {
		//this.run(reverse, undefined);
	}

	/**
	 * Step to the next/previous non empty line.
	 */
	public step(reverse = false, event = 'stopOnStep') {
		//this.run(reverse, event);
	}

	/**
	 * Returns a fake 'stacktrace' where every 'stackframe' is a word from the current line.
	 */
	public stack(startFrame: number, endFrame: number): any {
		/*
				const words = this._sourceLines[this._currentLine].trim().split(/\s+/);

				const frames = new Array<any>();
				// every word of the current line becomes a stack frame.
				for (let i = startFrame; i < Math.min(endFrame, words.length); i++) {
					const name = words[i];	// use a word of the line as the stackframe name
					frames.push({
						index: i,
						name: `${name}(${i})`,
						file: this._sourceFiles[0],
						line: this._currentLine
					});
				}
				return {
					frames: frames,
					count: words.length
				}; */
	}

	/*
	 * Set breakpoint in file with given line.
	 */
	public async setBreakPoint(path: string, line: number): Promise<MockBreakpoint> {

		const bp = <MockBreakpoint>{ verified: false, line, id: this._breakpointId++ };
		let bps = this._breakPoints.get(path);
		if (!bps) {
			bps = new Array<MockBreakpoint>();
			this._breakPoints.set(path, bps);
		}

		await this.sendToGdb(`set breakpoint pending on\n`)
		await this.sendToGdb(`break ${path}:${line + 1}\n`)
		await this.validateBreakpoint(bp)

		bps.push(bp);
		this.sendEvent('breakpointValidated', bp);
		return bp;
	}

	private async validateBreakpoint(bp: MockBreakpoint) {
		let gdbRespInfo: string[] = (await this.sendToGdb(`info breakpoint ${bp.id}\n`)).split('\n')
		// if only one breakpoint and header adjust line
		if (gdbRespInfo.length == 2) {
			let line = /:(\d+)$/.exec(gdbRespInfo[1])
			bp.verified = true
			if (line && line[1]) {
				bp.line = parseInt(<string>line[1])-1;
			}
		}
	}

	/*
	 * Clear all breakpoints for file.
	 */
	public async clearBreakpoints(path: string) {
		let fileBreakpoints = this._breakPoints.get(path)
		if (fileBreakpoints){
			await fileBreakpoints.forEach(async bp => {
				await this.sendToGdb(`delete ${bp.id}\n`)
			});
		}
		this._breakPoints.delete(path);
	}

	// private methods

	private loadSources(gdbSourcesStrings: string) {
		let lines = gdbSourcesStrings.replace(/,/im, '').split('\n')
		lines.reverse()
		this._sourceFiles = []
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].trim().startsWith('/'))
				this.sourceFiles.push(lines[i].trim())
		}
	}

	/**
	 * Run through the file.
	 * If stepEvent is specified only run a single step and emit the stepEvent.
	 */
	private run(reverse = false, stepEvent?: string) {
		/* if (reverse) {
			for (let ln = this._currentLine - 1; ln >= 0; ln--) {
				if (this.fireEventsForLine(ln, stepEvent)) {
					this._currentLine = ln;
					return;
				}
			}
			// no more lines: stop at first line
			this._currentLine = 0;
			this.sendEvent('stopOnEntry');
		} else {
			for (let ln = this._currentLine + 1; ln < this._sourceLines.length; ln++) {
				if (this.fireEventsForLine(ln, stepEvent)) {
					this._currentLine = ln;
					return true;
				}
			}
			// no more lines: run to end
			this.sendEvent('end');
		} */
	}

	/**
	 * Fire events if line has a breakpoint or the word 'exception' is found.
	 * Returns true is execution needs to stop.
	 */
	private fireEventsForLine(ln: number, stepEvent?: string): boolean {

		/* 	const line = this._sourceLines[ln].trim();

			// if 'log(...)' found in source -> send argument to debug console
			const matches = /log\((.*)\)/.exec(line);
			if (matches && matches.length === 2) {
				this.sendEvent('output', matches[1], this._sourceFiles[0], ln, matches.index)
			}

			// if word 'exception' found in source -> throw exception
			if (line.indexOf('exception') >= 0) {
				this.sendEvent('stopOnException');
				return true;
			}

			// is there a breakpoint?
			const breakpoints = this._breakPoints.get(this._sourceFiles[0]);
			if (breakpoints) {
				const bps = breakpoints.filter(bp => bp.line === ln);
				if (bps.length > 0) {

					// send 'stopped' event
					this.sendEvent('stopOnBreakpoint');

					// the following shows the use of 'breakpoint' events to update properties of a breakpoint in the UI
					// if breakpoint is not yet verified, verify it now and send a 'breakpoint' update event
					if (!bps[0].verified) {
						bps[0].verified = true;
						this.sendEvent('breakpointValidated', bps[0]);
					}
					return true;
				}
			}

			// non-empty line
			if (stepEvent && line.length > 0) {
				this.sendEvent(stepEvent);
				return true;
			}

			// nothing interesting found -> continue*/
		return false;
	}

	private sendEvent(event: string, ...args: any[]) {
		setImmediate(_ => {
			this.emit(event, ...args);
		});
	}
}