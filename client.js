import Backoff from "backo2";
import EventEmitter from "eventemitter3";
import $$observable from "symbol-observable";

const WS_TIMEOUT = 30000;

function isString(value) {
  return typeof value === "string";
}
function isObject(value) {
  return value !== null && typeof value === "object";
}

export class SubscriptionClient {
  constructor(url, options) {
    const {
      connectionCallback = undefined,
      connectionParams = {},
      timeout = WS_TIMEOUT,
      reconnect = false,
      reconnectionAttempts = Infinity,
      lazy = false,
      inactivityTimeout = 0
    } = options || {};

    this.wsImpl = WebSocket;
    this.connectionCallback = connectionCallback;
    this.url = url;
    this.operations = {};
    this.nextOperationId = 0;
    this.wsTimeout = timeout;
    this.unsentMessagesQueue = [];
    this.reconnect = reconnect;
    this.reconnecting = false;
    this.reconnectionAttempts = reconnectionAttempts;
    this.lazy = !!lazy;
    this.inactivityTimeout = inactivityTimeout;
    this.closedByUser = false;
    this.backoff = new Backoff({ jitter: 0.5 });
    this.eventEmitter = new EventEmitter();
    this.middlewares = [];
    this.client = null;
    this.maxConnectTimeGenerator = this.createMaxConnectTimeGenerator();
    this.connectionParams = this.getConnectionParams(connectionParams);

    if (!this.lazy) {
      this.connect();
    }
  }

  get status() {
    if (this.client === null) {
      return this.wsImpl.CLOSED;
    }

    return this.client.readyState;
  }

  close(isForced = true, closedByUser = true) {
    this.clearInactivityTimeout();
    if (this.client !== null) {
      this.closedByUser = closedByUser;

      if (isForced) {
        this.clearCheckConnectionInterval();
        this.clearMaxConnectTimeout();
        this.clearTryReconnectTimeout();
        this.unsubscribeAll();
        this.sendMessage(undefined, "connection_terminate", null);
      }

      this.client.close();
      this.client = null;
      this.eventEmitter.emit("disconnected");

      if (!isForced) {
        this.tryReconnect();
      }
    }
  }

  request(request) {
    const getObserver = this.getObserver.bind(this);
    const executeOperation = this.executeOperation.bind(this);
    const unsubscribe = this.unsubscribe.bind(this);

    let opId;

    this.clearInactivityTimeout();

    return {
      [$$observable]() {
        return this;
      },
      subscribe(observerOrNext, onError, onComplete) {
        const observer = getObserver(observerOrNext, onError, onComplete);
        opId = executeOperation(request, (error, result) => {
          if (error === null && result === null) {
            if (observer.complete) {
              observer.complete();
            }
          } else if (error) {
            if (observer.error) {
              observer.error(error[0]);
            }
          } else {
            if (observer.next) {
              observer.next(result);
            }
          }
        });

        return {
          unsubscribe: () => {
            if (opId) {
              unsubscribe(opId);
              opId = null;
            }
          }
        };
      }
    };
  }

  on(eventName, callback, context) {
    const handler = this.eventEmitter.on(eventName, callback, context);
    return () => {
      handler.off(eventName, callback, context);
    };
  }
  onConnected(callback, context) {
    return this.on("connected", callback, context);
  }
  onConnecting(callback, context) {
    return this.on("connecting", callback, context);
  }
  onDisconnected(callback, context) {
    return this.on("disconnected", callback, context);
  }
  onReconnected(callback, context) {
    return this.on("reconnected", callback, context);
  }
  onReconnecting(callback, context) {
    return this.on("reconnecting", callback, context);
  }
  onError(callback, context) {
    return this.on("error", callback, context);
  }

  unsubscribeAll() {
    Object.keys(this.operations).forEach(subId => {
      this.unsubscribe(subId);
    });
  }

  applyMiddlewares(options) {
    return new Promise((resolve, reject) => {
      const queue = (funcs, scope) => {
        const next = error => {
          if (error) {
            reject(error);
          } else {
            if (funcs.length > 0) {
              const f = funcs.shift();
              if (f) {
                f.applyMiddleware.apply(scope, [options, next]);
              }
            } else {
              resolve(options);
            }
          }
        };
        next();
      };

      queue([...this.middlewares], this);
    });
  }

  use(middlewares) {
    middlewares.map(middleware => {
      if (typeof middleware.applyMiddleware === "function") {
        this.middlewares.push(middleware);
      } else {
        throw new TypeError(
          "Middleware must implement the applyMiddleware function."
        );
      }
    });

    return this;
  }

  getConnectionParams(connectionParams) {
    return () =>
      new Promise((resolve, reject) => {
        if (typeof connectionParams === "function") {
          try {
            return resolve(connectionParams.call(null));
          } catch (error) {
            return reject(error);
          }
        }

        resolve(connectionParams);
      });
  }

  executeOperation(options, handler) {
    if (this.client === null) {
      this.connect();
    }

    const opId = this.generateOperationId();
    this.operations[opId] = { options: options, handler };

    this.applyMiddlewares(options)
      .then(processedOptions => {
        this.checkOperationOptions(processedOptions, handler);
        if (this.operations[opId]) {
          this.operations[opId] = { options: processedOptions, handler };
          this.sendMessage(opId, "start", processedOptions);
        }
      })
      .catch(error => {
        this.unsubscribe(opId);
        handler(this.formatErrors(error));
      });

    return opId;
  }

  getObserver(observerOrNext, error, complete) {
    if (typeof observerOrNext === "function") {
      return {
        next: v => observerOrNext(v),
        error: e => error && error(e),
        complete: () => complete && complete()
      };
    }
    return observerOrNext;
  }

  createMaxConnectTimeGenerator() {
    const minValue = 1000;
    const maxValue = this.wsTimeout;
    return new Backoff({
      min: minValue,
      max: maxValue,
      factor: 1.2
    });
  }

  clearCheckConnectionInterval() {
    if (this.checkConnectionIntervalId) {
      clearInterval(this.checkConnectionIntervalId);
      this.checkConnectionIntervalId = null;
    }
  }
  clearMaxConnectTimeout() {
    if (this.maxConnectTimeoutId) {
      clearTimeout(this.maxConnectTimeoutId);
      this.maxConnectTimeoutId = null;
    }
  }
  clearTryReconnectTimeout() {
    if (this.tryReconnectTimeoutId) {
      clearTimeout(this.tryReconnectTimeoutId);
      this.tryReconnectTimeoutId = null;
    }
  }
  clearInactivityTimeout() {
    if (this.inactivityTimeoutId) {
      clearTimeout(this.inactivityTimeoutId);
      this.inactivityTimeoutId = null;
    }
  }
  setInactivityTimeout() {
    if (
      this.inactivityTimeout > 0 &&
      Object.keys(this.operations).length === 0
    ) {
      this.inactivityTimeoutId = setTimeout(() => {
        if (Object.keys(this.operations).length === 0) {
          this.close();
        }
      }, this.inactivityTimeout);
    }
  }

  checkOperationOptions(options, handler) {
    const { query, variables, operationName } = options;
    if (!query) {
      throw new Error("Must provide a query.");
    }
    if (!handler) {
      throw new Error("Must provide an handler.");
    }
    if (
      !isString(query) ||
      (operationName && !isString(operationName)) ||
      (variables && !isObject(variables))
    ) {
      throw new Error(
        "Incorrect option types. query must be a string," +
          "`operationName` must be a string, and `variables` must be an object."
      );
    }
  }

  buildMessage(id, type, payload) {
    const payloadToReturn =
      payload && payload.query
        ? Object.assign({}, payload, {
            query: payload.query
          })
        : payload;
    return {
      id,
      type,
      payload: payloadToReturn
    };
  }

  formatErrors(errors) {
    if (Array.isArray(errors)) {
      return errors;
    }
    if (errors && errors.errors) {
      return this.formatErrors(errors.errors);
    }
    if (errors && errors.message) {
      return [errors];
    }
    return [
      {
        name: "FormatedError",
        message: "Unknown error",
        originalError: errors
      }
    ];
  }

  sendMessage(id, type, payload) {
    this.sendMessageRaw(this.buildMessage(id, type, payload));
  }

  // send message, or queue it if connection is not open
  sendMessageRaw(message) {
    switch (this.status) {
      case this.wsImpl.OPEN:
        let serializedMessage = JSON.stringify(message);
        try {
          JSON.parse(serializedMessage);
        } catch (error) {
          this.eventEmitter.emit(
            "error",
            new Error(`Message must be JSON-serializable. Got: ${message}`)
          );
        }
        this.client.send(serializedMessage);
        break;
      case this.wsImpl.CONNECTING:
        this.unsentMessagesQueue.push(message);
        break;
      default:
        if (!this.reconnecting) {
          this.eventEmitter.emit(
            "error",
            new Error(
              "A message was not sent because socket is not connected, is closing or " +
                "is already closed. Message was: " +
                JSON.stringify(message)
            )
          );
        }
    }
  }

  generateOperationId() {
    return String(++this.nextOperationId);
  }
  tryReconnect() {
    if (!this.reconnect || this.backoff.attempts >= this.reconnectionAttempts) {
      return;
    }

    if (!this.reconnecting) {
      Object.keys(this.operations).forEach(key => {
        this.unsentMessagesQueue.push(
          this.buildMessage(key, "start", this.operations[key].options)
        );
      });
      this.reconnecting = true;
    }

    this.clearTryReconnectTimeout();

    const delay = this.backoff.duration();
    this.tryReconnectTimeoutId = setTimeout(() => {
      this.connect();
    }, delay);
  }

  flushUnsentMessagesQueue() {
    this.unsentMessagesQueue.forEach(message => {
      this.sendMessageRaw(message);
    });
    this.unsentMessagesQueue = [];
  }

  checkConnection() {
    if (this.wasKeepAliveReceived) {
      this.wasKeepAliveReceived = false;
      return;
    }

    if (!this.reconnecting) {
      this.close(false, true);
    }
  }

  checkMaxConnectTimeout() {
    this.clearMaxConnectTimeout();

    // Max timeout trying to connect
    this.maxConnectTimeoutId = setTimeout(() => {
      if (this.status !== this.wsImpl.OPEN) {
        this.reconnecting = true;
        this.close(false, true);
      }
    }, this.maxConnectTimeGenerator.duration());
  }

  connect() {
    this.client = new WebSocket(this.url, "graphql-ws");

    this.checkMaxConnectTimeout();

    this.client.addEventListener("open", async () => {
      if (this.status === this.wsImpl.OPEN) {
        this.clearMaxConnectTimeout();
        this.closedByUser = false;
        this.eventEmitter.emit(
          this.reconnecting ? "reconnecting" : "connecting"
        );

        try {
          const connectionParams = await this.connectionParams();

          // Send connection_init message, no need to wait for connection to success (reduce roundtrips)
          this.sendMessage(undefined, "connection_init", connectionParams);
          this.flushUnsentMessagesQueue();
        } catch (error) {
          this.sendMessage(undefined, "connection_error", error);
          this.flushUnsentMessagesQueue();
        }
      }
    });

    this.client.onclose = () => {
      if (!this.closedByUser) {
        this.close(false, false);
      }
    };

    this.client.addEventListener("error", error => {
      // Capture and ignore errors to prevent unhandled exceptions, wait for
      // onclose to fire before attempting a reconnect.
      this.eventEmitter.emit("error", error);
    });

    this.client.addEventListener("message", ({ data }) => {
      this.processReceivedData(data);
    });
  }

  processReceivedData(receivedData) {
    let parsedMessage;
    let opId;

    try {
      parsedMessage = JSON.parse(receivedData);
      opId = parsedMessage.id;
    } catch (error) {
      throw new Error(`Message must be JSON-parseable. Got: ${receivedData}`);
    }

    if (
      ["data", "complete", "error"].includes(parsedMessage.type) &&
      !this.operations[opId]
    ) {
      this.unsubscribe(opId);

      return;
    }

    switch (parsedMessage.type) {
      case "connection_error":
        if (this.connectionCallback) {
          this.connectionCallback(parsedMessage.payload);
        }
        break;

      case "connection_ack":
        this.eventEmitter.emit(this.reconnecting ? "reconnected" : "connected");
        this.reconnecting = false;
        this.backoff.reset();
        this.maxConnectTimeGenerator.reset();

        if (this.connectionCallback) {
          this.connectionCallback();
        }
        break;

      case "complete":
        this.operations[opId].handler(null, null);
        delete this.operations[opId];
        break;

      case "error":
        this.operations[opId].handler(
          this.formatErrors(parsedMessage.payload),
          null
        );
        delete this.operations[opId];
        break;

      case "data":
        const parsedPayload = !parsedMessage.payload.errors
          ? parsedMessage.payload
          : {
              ...parsedMessage.payload,
              errors: this.formatErrors(parsedMessage.payload.errors)
            };
        this.operations[opId].handler(null, parsedPayload);
        break;

      case "ka":
        const firstKA = typeof this.wasKeepAliveReceived === "undefined";
        this.wasKeepAliveReceived = true;

        if (firstKA) {
          this.checkConnection();
        }

        if (this.checkConnectionIntervalId) {
          clearInterval(this.checkConnectionIntervalId);
          this.checkConnection();
        }
        this.checkConnectionIntervalId = setInterval(
          this.checkConnection.bind(this),
          this.wsTimeout
        );
        break;

      default:
        throw new Error("Invalid message type!");
    }
  }

  unsubscribe(opId) {
    if (this.operations[opId]) {
      delete this.operations[opId];
      this.setInactivityTimeout();
      this.sendMessage(opId, "stop", undefined);
    }
  }
}
