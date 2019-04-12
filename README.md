# graphql-subscriptions-client

This is based directly on the client from [subscriptions-transport-ws](https://github.com/apollographql/subscriptions-transport-ws). It uses native websockets to communicate with a graphql server which is using ['graphql-ws' protocol](https://github.com/apollographql/subscriptions-transport-ws/blob/master/PROTOCOL.md). It plays nice with rollup, too.

## Usage

If you have a apollo-server instance you can use this for subscriptions only, pass all requests over the websocket.

```js
import { SubscriptionClient } from 'subscriptions-transport-ws';

const GRAPHQL_ENDPOINT = 'ws://localhost:3000/graphql';

const client = new SubscriptionClient(GRAPHQL_ENDPOINT, {
  reconnect: true,
});

const query = `subscription onNewItem {
        newItemCreated {
            id
        }
    }`

client.request({query})
```

Query must be string.