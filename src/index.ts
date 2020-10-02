/// <reference lib="dom" />
import WebSocket from 'ws'
import Backoff from 'backo2'
import EventEmitter, { ListenerFn } from 'eventemitter3'
import $$observable from 'symbol-observable'

const WS_MINTIMEOUT = 1000
const WS_TIMEOUT = 30000

const isString = (value: unknown): value is string => typeof value === 'string';
const isObject = (value: unknown): value is object => value !== null && typeof value === 'object';

export interface Observer<T> {
  next?: (value: T) => void
  error?: (error: Error) => void
  complete?: () => void
}

export interface Observable<T> {
  subscribe(
    observer: Observer<T>
  ): {
    unsubscribe: () => void
  }
}

export interface OperationOptions {
  query: string
  variables?: Object
  operationName?: string
  [key: string]: any
}

export type OperationsHandler = (error?: Error, data?: unknown) => any;

interface Operations {
  [key: string]: {
    options: OperationOptions,
    handler: OperationsHandler
  }
}

export declare type ConnectionParams = {
  [paramName: string]: unknown
}

export declare type ConnectionParamsOptions =
  | ConnectionParams
  | Function
  | Promise<ConnectionParams>

export interface ClientOptions {
  connectionCallback?: (error?: Error[], result?: unknown) => void
  connectionParams?: ConnectionParamsOptions
  minTimeout?: number
  timeout?: number
  reconnect?: boolean
  reconnectionAttempts?: number
  lazy?: boolean
  inactivityTimeout?: number
}

type MessageType = 'start' | 'stop' | 'connection_init' | 'connection_terminate' | 'connection_error';

export class SubscriptionClient {
  private wsImpl: typeof WebSocket;
  private connectionCallback;
  private url: string;
  private operations: Operations;
  private nextOperationId: number;
  private wsMinTimeout: number;
  private wsTimeout: number;
  private unsentMessagesQueue: unknown[];
  private reconnect: boolean;
  private reconnecting: boolean;
  private reconnectionAttempts: number;
  private lazy: boolean;
  private inactivityTimeout: number;
  private closedByUser: boolean;
  private backoff: Backoff;
  private eventEmitter: EventEmitter;
  private client: WebSocket;
  private maxConnectTimeGenerator: Backoff;
  private connectionParams: () => Promise<any>;
  private checkConnectionIntervalId: NodeJS.Timeout;
  private maxConnectTimeoutId: NodeJS.Timeout;
  private tryReconnectTimeoutId: NodeJS.Timeout;
  private inactivityTimeoutId: NodeJS.Timeout;
  private wasKeepAliveReceived: boolean;

  constructor(url: string, options: ClientOptions) {
    const {
      connectionCallback = undefined,
      connectionParams = {},
      minTimeout = WS_MINTIMEOUT,
      timeout = WS_TIMEOUT,
      reconnect = false,
      reconnectionAttempts = Infinity,
      lazy = false,
      inactivityTimeout = 0
    } = options || {}

    this.wsImpl = WebSocket
    this.connectionCallback = connectionCallback
    this.url = url
    this.operations = {}
    this.nextOperationId = 0
    this.wsMinTimeout = minTimeout
    this.wsTimeout = timeout
    this.unsentMessagesQueue = []
    this.reconnect = reconnect
    this.reconnecting = false
    this.reconnectionAttempts = reconnectionAttempts
    this.lazy = !!lazy
    this.inactivityTimeout = inactivityTimeout
    this.closedByUser = false
    this.backoff = new Backoff({ jitter: 0.5 })
    this.eventEmitter = new EventEmitter()
    this.client = null
    this.maxConnectTimeGenerator = this.createMaxConnectTimeGenerator()
    this.connectionParams = this.getConnectionParams(connectionParams)

    if (!this.lazy) {
      this.connect()
    }
  }

  get status(): number {
    if (this.client === null) {
      return this.wsImpl.CLOSED
    }

    return this.client.readyState
  }

  close(isForced = true, closedByUser = true) {
    this.clearInactivityTimeout()
    if (this.client !== null) {
      this.closedByUser = closedByUser

      if (isForced) {
        this.clearCheckConnectionInterval()
        this.clearMaxConnectTimeout()
        this.clearTryReconnectTimeout()
        this.unsubscribeAll()
        this.sendMessage(undefined, 'connection_terminate', null)
      }

      this.client.close()
      this.client = null
      this.eventEmitter.emit('disconnected')

      if (!isForced) {
        this.tryReconnect()
      }
    }
  }

  request(request: OperationOptions) {
    const getObserver = this.getObserver.bind(this)
    const executeOperation = this.executeOperation.bind(this)
    const unsubscribe = this.unsubscribe.bind(this)

    let opId: any

    this.clearInactivityTimeout()

    return {
      [$$observable]() {
        return this
      },
      subscribe(observerOrNext: any, onError?: any, onComplete?: any) {
        const observer = getObserver(observerOrNext, onError, onComplete)
        opId = executeOperation(request, (error: any, result: any) => {
          if (error === null && result === null) {
            if (observer.complete) {
              observer.complete()
            }
          } else if (error) {
            if (observer.error) {
              observer.error(error[0])
            }
          } else {
            if (observer.next) {
              observer.next(result)
            }
          }
        })

        return {
          unsubscribe: () => {
            if (opId) {
              unsubscribe(opId)
              opId = null
            }
          }
        }
      }
    }
  }

  on(eventName: string, callback: ListenerFn, context: unknown) {
    const handler = this.eventEmitter.on(eventName, callback, context)
    return () => {
      handler.off(eventName, callback, context)
    }
  }

  onConnected(callback: ListenerFn, context: unknown) {
    return this.on('connected', callback, context)
  }

  onConnecting(callback: ListenerFn, context: unknown) {
    return this.on('connecting', callback, context)
  }

  onDisconnected(callback: ListenerFn, context: unknown) {
    return this.on('disconnected', callback, context)
  }

  onReconnected(callback: ListenerFn, context: unknown) {
    return this.on('reconnected', callback, context)
  }

  onReconnecting(callback: ListenerFn, context: unknown) {
    return this.on('reconnecting', callback, context)
  }

  onError(callback: ListenerFn, context: unknown) {
    return this.on('error', callback, context)
  }

  unsubscribeAll() {
    Object.keys(this.operations).forEach(subId => {
      this.unsubscribe(subId)
    })
  }

  getConnectionParams(connectionParams: Function | { [key: string]: any }) {
    return () => {
      return new Promise((resolve, reject) => {
        if (typeof connectionParams === 'function') {
          try {
            return resolve(connectionParams())
          } catch (error) {
            return reject(error)
          }
        }

        resolve(connectionParams)
      })
    }
  }

  executeOperation(options: OperationOptions, handler: OperationsHandler) {
    if (this.client === null) {
      this.connect()
    }

    const opId = this.generateOperationId()
    this.operations[opId] = { options: options, handler }

    try {
      this.checkOperationOptions(options, handler)
      if (this.operations[opId]) {
        this.operations[opId] = { options, handler }
        this.sendMessage(opId, 'start', options)
      }
    } catch (error) {
      this.unsubscribe(opId)
      handler(this.formatErrors(error))
    }

    return opId
  }

  getObserver(observerOrNext?: any, error?: any, complete?: any) {
    // Next
    if (typeof observerOrNext === 'function') {
      return {
        next: (value: any) => observerOrNext(value),
        error: (e: any) => error && error(e),
        complete: () => complete && complete()
      }
    }
    // Observer
    return observerOrNext
  }

  createMaxConnectTimeGenerator() {
    const minValue = this.wsMinTimeout
    const maxValue = this.wsTimeout
    return new Backoff({
      min: minValue,
      max: maxValue,
      factor: 1.2
    })
  }

  clearCheckConnectionInterval() {
    if (this.checkConnectionIntervalId) {
      clearInterval(this.checkConnectionIntervalId)
      this.checkConnectionIntervalId = null
    }
  }

  clearMaxConnectTimeout() {
    if (this.maxConnectTimeoutId) {
      clearTimeout(this.maxConnectTimeoutId)
      this.maxConnectTimeoutId = null
    }
  }

  clearTryReconnectTimeout() {
    if (this.tryReconnectTimeoutId) {
      clearTimeout(this.tryReconnectTimeoutId)
      this.tryReconnectTimeoutId = null
    }
  }

  clearInactivityTimeout() {
    if (this.inactivityTimeoutId) {
      clearTimeout(this.inactivityTimeoutId)
      this.inactivityTimeoutId = null
    }
  }

  setInactivityTimeout() {
    if (
      this.inactivityTimeout > 0 &&
      Object.keys(this.operations).length === 0
    ) {
      this.inactivityTimeoutId = setTimeout(() => {
        if (Object.keys(this.operations).length === 0) {
          this.close()
        }
      }, this.inactivityTimeout)
    }
  }

  checkOperationOptions(options: OperationOptions, handler: OperationsHandler) {
    const { query, variables, operationName } = options
    if (!query) {
      throw new Error('Must provide a query.')
    }
    if (!handler) {
      throw new Error('Must provide an handler.')
    }
    if (
      !isString(query) ||
      (operationName && !isString(operationName)) ||
      (variables && !isObject(variables))
    ) {
      throw new Error(
        'Incorrect option types. query must be a string,' +
        '`operationName` must be a string, and `variables` must be an object.'
      )
    }
  }

  buildMessage(id: string, type: MessageType, payload: any) {
    const payloadToReturn =
      payload && payload.query
        ? Object.assign({}, payload, {
          query: payload.query
        })
        : payload
    return {
      id,
      type,
      payload: payloadToReturn
    }
  }

  formatErrors(errors: any): any {
    if (Array.isArray(errors)) {
      return errors
    }
    if (errors && errors.errors) {
      return this.formatErrors(errors.errors)
    }
    if (errors && errors.message) {
      return [errors]
    }
    return [
      {
        name: 'FormatedError',
        message: 'Unknown error',
        originalError: errors
      }
    ]
  }

  sendMessage(id: string | undefined, type: MessageType, payload: any) {
    this.sendMessageRaw(this.buildMessage(id, type, payload))
  }

  // send message, or queue it if connection is not open
  sendMessageRaw(message: any) {
    switch (this.status) {
      case this.wsImpl.OPEN:
        const serializedMessage = JSON.stringify(message)
        try {
          JSON.parse(serializedMessage)
        } catch (error) {
          this.eventEmitter.emit(
            'error',
            new Error(`Message must be JSON-serializable. Got: ${message}`)
          )
        }
        this.client.send(serializedMessage)
        break
      case this.wsImpl.CONNECTING:
        this.unsentMessagesQueue.push(message)
        break
      default:
        if (!this.reconnecting) {
          this.eventEmitter.emit(
            'error',
            new Error(
              'A message was not sent because socket is not connected, is closing or ' +
              'is already closed. Message was: ' +
              JSON.stringify(message)
            )
          )
        }
    }
  }

  generateOperationId() {
    return String(++this.nextOperationId)
  }

  tryReconnect() {
    if (!this.reconnect || this.backoff.attempts >= this.reconnectionAttempts) {
      return
    }

    if (!this.reconnecting) {
      Object.keys(this.operations).forEach(key => {
        this.unsentMessagesQueue.push(
          this.buildMessage(key, 'start', this.operations[key].options)
        )
      })
      this.reconnecting = true
    }

    this.clearTryReconnectTimeout()

    const delay = this.backoff.duration()
    this.tryReconnectTimeoutId = setTimeout(() => {
      this.connect()
    }, delay)
  }

  flushUnsentMessagesQueue() {
    this.unsentMessagesQueue.forEach(message => {
      this.sendMessageRaw(message)
    })
    this.unsentMessagesQueue = []
  }

  checkConnection() {
    if (this.wasKeepAliveReceived) {
      this.wasKeepAliveReceived = false
      return
    }

    if (!this.reconnecting) {
      this.close(false, true)
    }
  }

  checkMaxConnectTimeout() {
    this.clearMaxConnectTimeout()

    // Max timeout trying to connect
    this.maxConnectTimeoutId = setTimeout(() => {
      if (this.status !== this.wsImpl.OPEN) {
        this.reconnecting = true
        this.close(false, true)
      }
    }, this.maxConnectTimeGenerator.duration())
  }

  connect() {
    this.client = new WebSocket(this.url, 'graphql-ws')

    this.checkMaxConnectTimeout()

    this.client.addEventListener('open', async () => {
      if (this.status === this.wsImpl.OPEN) {
        this.clearMaxConnectTimeout()
        this.closedByUser = false
        this.eventEmitter.emit(
          this.reconnecting ? 'reconnecting' : 'connecting'
        )

        try {
          const connectionParams = await this.connectionParams()

          // Send connection_init message, no need to wait for connection to success (reduce roundtrips)
          this.sendMessage(undefined, 'connection_init', connectionParams)
          this.flushUnsentMessagesQueue()
        } catch (error) {
          this.sendMessage(undefined, 'connection_error', error)
          this.flushUnsentMessagesQueue()
        }
      }
    })

    this.client.onclose = () => {
      if (!this.closedByUser) {
        this.close(false, false)
      }
    }

    this.client.addEventListener('error', error => {
      // Capture and ignore errors to prevent unhandled exceptions, wait for
      // onclose to fire before attempting a reconnect.
      this.eventEmitter.emit('error', error)
    })

    this.client.addEventListener('message', ({ data }) => {
      this.processReceivedData(data)
    })
  }

  processReceivedData(receivedData: string) {
    let parsedMessage
    let opId

    try {
      parsedMessage = JSON.parse(receivedData)
      opId = parsedMessage.id
    } catch (error) {
      throw new Error(`Message must be JSON-parseable. Got: ${receivedData}`)
    }

    if (
      ['data', 'complete', 'error'].includes(parsedMessage.type) &&
      !this.operations[opId]
    ) {
      this.unsubscribe(opId)

      return
    }

    switch (parsedMessage.type) {
      case 'connection_error':
        if (this.connectionCallback) {
          this.connectionCallback(parsedMessage.payload)
        }
        break

      case 'connection_ack':
        this.eventEmitter.emit(this.reconnecting ? 'reconnected' : 'connected')
        this.reconnecting = false
        this.backoff.reset()
        this.maxConnectTimeGenerator.reset()

        if (this.connectionCallback) {
          this.connectionCallback()
        }
        break

      case 'complete':
        this.operations[opId].handler(null, null)
        delete this.operations[opId]
        break

      case 'error':
        this.operations[opId].handler(
          this.formatErrors(parsedMessage.payload),
          null
        )
        delete this.operations[opId]
        break

      case 'data':
        const parsedPayload = !parsedMessage.payload.errors
          ? parsedMessage.payload
          : {
            ...parsedMessage.payload,
            errors: this.formatErrors(parsedMessage.payload.errors)
          }
        this.operations[opId].handler(null, parsedPayload)
        break

      case 'ka':
        const firstKA = typeof this.wasKeepAliveReceived === 'undefined'
        this.wasKeepAliveReceived = true

        if (firstKA) {
          this.checkConnection()
        }

        if (this.checkConnectionIntervalId) {
          clearInterval(this.checkConnectionIntervalId)
          this.checkConnection()
        }
        this.checkConnectionIntervalId = setInterval(
          this.checkConnection.bind(this),
          this.wsTimeout
        )
        break

      default:
        throw new Error('Invalid message type!')
    }
  }

  unsubscribe(opId: string) {
    if (this.operations[opId]) {
      delete this.operations[opId]
      this.setInactivityTimeout()
      this.sendMessage(opId, 'stop', undefined)
    }
  }
}
