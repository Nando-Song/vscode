/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import winjs = require('vs/base/common/winjs.base');
import marshalling = require('vs/base/common/marshalling');
import errors = require('vs/base/common/errors');
import { IMessagePassingProtocol } from 'vs/base/parts/ipc/common/ipc';
import { LazyPromise } from "vs/workbench/services/extensions/node/lazyPromise";

interface IRPCFunc {
	(rpcId: string, method: string, args: any[]): winjs.TPromise<any>;
}

let lastMessageId = 0;
const pendingRPCReplies: { [msgId: string]: LazyPromise; } = {};

class MessageFactory {
	public static cancel(req: string): string {
		return `{"cancel":"${req}"}`;
	}

	public static request(req: string, rpcId: string, method: string, args: any[]): string {
		return `{"req":"${req}","rpcId":"${rpcId}","method":"${method}","args":${marshalling.stringify(args)}}`;
	}

	public static replyOK(req: string, res: any): string {
		if (typeof res === 'undefined') {
			return `{"seq":"${req}"}`;
		}
		return `{"seq":"${req}","res":${marshalling.stringify(res)}}`;
	}

	public static replyErr(req: string, err: any): string {
		if (typeof err === 'undefined') {
			return `{"seq":"${req}","err":null}`;
		}
		return `{"seq":"${req}","err":${marshalling.stringify(errors.transformErrorForSerialization(err))}}`;
	}
}

function createRPC(serializeAndSend: (value: string) => void): IRPCFunc {

	return function rpc(rpcId: string, method: string, args: any[]): winjs.TPromise<any> {
		let req = String(++lastMessageId);
		let result = new LazyPromise(() => {
			serializeAndSend(MessageFactory.cancel(req));
		});

		pendingRPCReplies[req] = result;

		serializeAndSend(MessageFactory.request(req, rpcId, method, args));

		return result;
	};
}

export interface IManyHandler {
	handle(rpcId: string, method: string, args: any[]): any;
}

export interface IRemoteCom {
	callOnRemote(proxyId: string, path: string, args: any[]): winjs.TPromise<any>;
	setManyHandler(handler: IManyHandler): void;
}

export function createProxyProtocol(protocol: IMessagePassingProtocol): IRemoteCom {
	let rpc = createRPC(sendDelayed);
	let bigHandler: IManyHandler = null;
	let invokedHandlers: { [req: string]: winjs.TPromise<any>; } = Object.create(null);
	let messagesToSend: string[] = [];

	let messagesToReceive: string[] = [];
	let receiveOneMessage = () => {
		let rawmsg = messagesToReceive.shift();

		if (messagesToReceive.length > 0) {
			process.nextTick(receiveOneMessage);
		}

		let msg = marshalling.parse(rawmsg);

		if (msg.seq) {
			if (!pendingRPCReplies.hasOwnProperty(msg.seq)) {
				console.warn('Got reply to unknown seq');
				return;
			}
			let reply = pendingRPCReplies[msg.seq];
			delete pendingRPCReplies[msg.seq];

			if (msg.err) {
				let err = msg.err;
				if (msg.err.$isError) {
					err = new Error();
					err.name = msg.err.name;
					err.message = msg.err.message;
					err.stack = msg.err.stack;
				}
				reply.resolveErr(err);
				return;
			}

			reply.resolveOk(msg.res);
			return;
		}

		if (msg.cancel) {
			if (invokedHandlers[msg.cancel]) {
				invokedHandlers[msg.cancel].cancel();
			}
			return;
		}

		if (msg.err) {
			console.error(msg.err);
			return;
		}

		let rpcId = msg.rpcId;

		if (!bigHandler) {
			throw new Error('got message before big handler attached!');
		}

		let req = msg.req;

		invokedHandlers[req] = invokeHandler(rpcId, msg.method, msg.args);

		invokedHandlers[req].then((r) => {
			delete invokedHandlers[req];
			sendDelayed(MessageFactory.replyOK(req, r));
		}, (err) => {
			delete invokedHandlers[req];
			sendDelayed(MessageFactory.replyErr(req, err));
		});
	};

	protocol.onMessage(data => {
		// console.log('RECEIVED ' + rawmsg.length + ' MESSAGES.');
		if (messagesToReceive.length === 0) {
			process.nextTick(receiveOneMessage);
		}

		messagesToReceive = messagesToReceive.concat(data);
	});

	let r: IRemoteCom = {
		callOnRemote: rpc,
		setManyHandler: (_bigHandler: IManyHandler): void => {
			bigHandler = _bigHandler;
		}
	};

	function sendAccumulated(): void {
		let tmp = messagesToSend;
		messagesToSend = [];

		// console.log('SENDING ' + tmp.length + ' MESSAGES.');
		protocol.send(tmp);
	}

	function sendDelayed(value: string): void {
		if (messagesToSend.length === 0) {
			process.nextTick(sendAccumulated);
		}
		messagesToSend.push(value);
	}

	function invokeHandler(rpcId: string, method: string, args: any[]): winjs.TPromise<any> {
		try {
			return winjs.TPromise.as(bigHandler.handle(rpcId, method, args));
		} catch (err) {
			return winjs.TPromise.wrapError(err);
		}
	}

	return r;
}

