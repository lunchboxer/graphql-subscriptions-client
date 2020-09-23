import { ListenerFn } from "eventemitter3"
import { ExecutionResult } from "graphql/execution/execute"

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

export declare type ConnectionParams = {
  [paramName: string]: any
}

export declare type ConnectionParamsOptions =
  | ConnectionParams
  | Function
  | Promise<ConnectionParams>

export interface ClientOptions {
  connectionCallback?: (error: Error[], result?: any) => void
  connectionParams?: ConnectionParamsOptions
  minTimeout?: number
  timeout?: number
  reconnect?: boolean
  reconnectionAttempts?: number
  lazy?: boolean
  inactivityTimeout?: number
}

export declare class SubscriptionClient {
  private wsImpl
  private connectionCallback
  private url
  private operations
  private nextOperationId
  private wsMinTimeout
  private wsTimeout
  private unsentMessagesQueue
  private reconnect
  private reconnecting
  private reconnectionAttempts
  private lazy
  private inactivityTimeout
  private closedByUser
  private backoff
  private eventEmitter
  private client
  private maxConnectTimeGenerator
  private connectionParams

  constructor(url: string, options?: ClientOptions)
  get status(): any
  close(isForced?: boolean, closedByUser?: boolean): void
  request(request: OperationOptions): Observable<ExecutionResult>
  on(eventName: string, callback: ListenerFn, context?: any): Function
  onConnected(callback: ListenerFn, context?: any): Function
  onConnecting(callback: ListenerFn, context?: any): Function
  onDisconnected(callback: ListenerFn, context?: any): Function
  onReconnected(callback: ListenerFn, context?: any): Function
  onReconnecting(callback: ListenerFn, context?: any): Function
  onError(callback: ListenerFn, context?: any): Function
  unsubscribeAll(): void

  private getConnectionParams
  private executeOperation
  private getObserver
  private createMaxConnectTimeGenerator
  private clearCheckConnectionInterval
  private clearMaxConnectTimeout
  private clearTryReconnectTimeout
  private clearInactivityTimeout
  private setInactivityTimeout
  private checkOperationOptions
  private buildMessage
  private formatErrors
  private sendMessage
  private sendMessageRaw
  private generateOperationId
  private tryReconnect
  private flushUnsentMessagesQueue
  private checkConnection
  private checkMaxConnectTimeout
  private connect
  private processReceivedData
  private unsubscribe
}
