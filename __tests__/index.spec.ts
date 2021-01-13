import WS from 'jest-websocket-mock';
import { SubscriptionClient } from "../src";

const wsEndpoint = 'ws://127.0.0.1:3007';
// @ts-ignore
const noop = () => void 0;

describe('Graphql Subscriptions Client', () => {
  let server: WS;
  beforeEach(async () => {
    server = new WS(wsEndpoint, { jsonProtocol: true });
  });

  afterEach(async () => {
    WS.clean();
  })

  it('should send simple query request', async () => {
    const client = new SubscriptionClient(wsEndpoint);
    await server.connected;

    client.request({ query: '{ hello }' }).subscribe(noop);
    await expect(server).toReceiveMessage({ "payload": {}, "type": "connection_init" });
    await expect(server).toReceiveMessage({ "id": "1", "payload": { "query": "{ hello }" }, "type": "start" });
  });

  it('should process simple query response', async done => {
    const client = new SubscriptionClient(wsEndpoint);
    await server.connected;

    client.request({ query: '{ hello }' }).subscribe(res => {
      expect(res).toEqual({ hello: "world" })
      done();
    });
    server.send({ id: "1", type: "data", payload: { hello: "world" } })
  });

  it('should process multiple query response', async done => {
    const client = new SubscriptionClient(wsEndpoint);
    await server.connected;

    client.request({ query: '{ hello }' }).subscribe(res => {
      expect(res).toEqual({ hello: "world" })
      done()
    });

    server.send([{ id: "1", type: "data", payload: { hello: "world" } }, { id: "1", type: "complete" }])
  });
});
