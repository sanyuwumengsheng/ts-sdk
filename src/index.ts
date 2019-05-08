import { ReadyStateCallback, RequestCallback } from './callback';
import { Packet } from './packet';
import { Utils } from './utils';

const MAX_PAYLOAD = 1024 * 1024;

/**
 * Client ws client, 单例模式, 负责维护连接
 */
class Client {
  private requestCallback: RequestCallback;
  private requestHeader: string;
  private responseHeader: string;
  private maxPayload: number;
  private url: string;
  private reconnectTimes: number;
  private reconnectLock: boolean;
  private socket: WebSocket;
  private readyStateCallback: ReadyStateCallback;

  constructor(url: string, readyStateCallback: ReadyStateCallback) {
    this.maxPayload = MAX_PAYLOAD;
    this.url = url;
    this.readyStateCallback = readyStateCallback;

    this.socket = this.connect();
  }

  // 向服务端发送ping包保持长连接
  ping(param = {}, requestCallback: RequestCallback) {
    if (this.socket.readyState !== this.socket.OPEN) {
      throw new Error('asyncSend: connection refuse');
    }

    this.addMessageListener(0, (data) => {
      let code = this.getResponseProperty('code');
      if (typeof code !== 'undefined') {
        let message = this.getResponseProperty('message');
        if (requestCallback.onError !== null) {
          requestCallback.onError(Number(code), message);
        }
      } else {
        requestCallback.onSuccess(data);
      }

      requestCallback.onEnd();
    });

    const p = new Packet();
    this.send(p.pack(0, 0, this.requestHeader, JSON.stringify(param)));
  }

  send(data) {
    if (this.socket.readyState !== this.socket.OPEN) {
      console.error('WebSocket is already in CLOSING or CLOSED state.');
      return;
    }
    try {
      this.socket.send(data);
    } catch (e) {
      console.log('send data error', e);
    }
  }

  /**
   * asyncSend
   * @param {*} operator
   * @param {*} param
   * @param {*} callback 仅此次有效的callback
   */
  asyncSend(operator, param, callback) {
    console.info('websocket send data', operator, this.requestHeader, param);

    if (typeof callback !== 'object') {
      throw new Error('callback must be an object');
    }

    if (this.socket.readyState !== this.socket.OPEN) {
      throw new Error('asyncSend: connection refuse');
    }

    if (
      callback.hasOwnProperty('onStart') &&
      typeof callback.onStart === 'function'
    ) {
      callback.onStart();
    }

    let sequence = new Date().getTime();
    let listener = Utils.crc32(operator) + sequence;
    this.requestCallback[listener] = (data) => {
      let code = this.getResponseProperty('code');
      if (typeof code !== 'undefined') {
        let message = this.getResponseProperty('message');
        if (
          callback.hasOwnProperty('onError') &&
          typeof callback.onError === 'function'
        ) {
          callback.onError(code, message);
        }
      } else {
        if (
          callback.hasOwnProperty('onSuccess') &&
          typeof callback.onSuccess === 'function'
        ) {
          callback.onSuccess(data);
        }
      }

      if (
        callback.hasOwnProperty('onEnd') &&
        typeof callback.onEnd === 'function'
      ) {
        callback.onEnd();
      }

      delete this.requestCallback[listener];
    };

    const p = new Packet();
    this.send(
      p.pack(
        Utils.crc32(operator),
        sequence,
        this.requestHeader,
        JSON.stringify(param),
      ),
    );
  }

  // 同步请求服务端数据
  async syncSend(operator, param, callback) {
    await this.asyncSend(operator, param, callback);
  }

  // 添加消息监听
  addMessageListener(operator, listener) {
    this.requestCallback[Utils.crc32(operator)] = listener;
  }

  // 移除消息监听
  removeMessageListener(operator) {
    delete this.requestCallback[Utils.crc32(operator)];
  }

  // 获取socket的链接状态
  getReadyState() {
    return this.socket.readyState;
  }

  // 设置单个请求能够处理的最大字节数
  setMaxPayload(maxPayload) {
    this.maxPayload = maxPayload;
  }

  // 设置请求属性
  setRequestProperty(key, value) {
    let v = this.getRequestProperty(key);

    this.requestHeader = this.requestHeader.replace(key + '=' + v + ';', '');
    this.requestHeader = this.requestHeader + key + '=' + value + ';';
  }

  // 获取请求属性
  getRequestProperty(key) {
    let values = this.requestHeader.split(';');
    for (let index in values) {
      let kv = values[index].split('=');
      if (kv[0] === key) {
        return kv[1];
      }
    }
  }

  // 设置Response属性
  setResponseProperty(key, value) {
    let v = this.getResponseProperty(key);

    this.responseHeader = this.responseHeader.replace(key + '=' + v + ';', '');
    this.responseHeader = this.responseHeader + key + '=' + value + ';';
  }

  // 获取响应属性
  getResponseProperty(key): string {
    let values = this.responseHeader.split(';');
    for (let index in values) {
      let kv = values[index].split('=');
      if (kv[0] === key) {
        return kv[1];
      }
    }

    return '';
  }

  // 创建连接
  connect(): WebSocket {
    const readyStateCallback = this.readyStateCallback;
    let ws = new WebSocket(this.url);

    ws.binaryType = 'blob';

    ws.onopen = (ev) => {
      this.reconnectTimes = 0;
      if (
        readyStateCallback.hasOwnProperty('onOpen') &&
        typeof readyStateCallback.onOpen === 'function'
      ) {
        readyStateCallback.onOpen(ev);
      }
    };

    ws.onclose = (ev) => {
      this.reconnect();
      if (
        readyStateCallback.hasOwnProperty('onClose') &&
        typeof readyStateCallback.onClose === 'function'
      ) {
        readyStateCallback.onClose(ev);
      }
    };

    ws.onerror = (ev) => {
      this.reconnect();
      if (
        readyStateCallback.hasOwnProperty('onError') &&
        typeof readyStateCallback.onError === 'function'
      ) {
        readyStateCallback.onError(ev);
      }
    };

    ws.onmessage = (ev) => {
      if (ev.data instanceof Blob) {
        let reader = new FileReader();
        reader.readAsArrayBuffer(ev.data);
        reader.onload = () => {
          try {
            let packet = new Packet().unPack(reader.result);
            let packetLength = packet.headerLength + packet.bodyLength + 20;
            if (packetLength > MAX_PAYLOAD) {
              throw new Error('the packet is big than ' + MAX_PAYLOAD);
            }

            let operator = Number(packet.operator) + Number(packet.sequence);
            if (this.requestCallback.hasOwnProperty(operator)) {
              if (packet.body === '') {
                packet.body = '{}';
              }
              this.responseHeader = packet.header;
              this.requestCallback[operator](JSON.parse(packet.body));
            }
            if (operator !== 0 && packet.body !== 'null') {
              console.info('receive data', packet.body);
            }
          } catch (e) {
            console.info(e);
            throw new Error(e);
          }
        };
      } else {
        throw new Error('websocket unsupported data format');
      }
    };

    return ws;
  }

  reconnect() {
    if (!this.reconnectLock) {
      this.reconnectLock = true;
      console.info('websocket reconnect in ' + this.reconnectTimes + 's');
      // 尝试重连
      setTimeout(() => {
        this.reconnectTimes++;
        this.socket = this.connect();
        this.reconnectLock = false;
      }, this.reconnectTimes * 1000);
    }
  }
}

export { Client, MAX_PAYLOAD };
