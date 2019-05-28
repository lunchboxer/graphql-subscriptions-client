# graphql-subscriptions-client

This is based directly on the client from [subscriptions-transport-ws](https://github.com/apollographql/subscriptions-transport-ws). It uses native websockets to communicate with a graphql server which is using ['graphql-ws' protocol](https://github.com/apollographql/subscriptions-transport-ws/blob/master/PROTOCOL.md). It plays nice with rollup, too.

## Usage

If you have a apollo-server instance you can use this for subscriptions only, pass all requests over the websocket.

```js
import { SubscriptionClient } from 'graphql-subscriptions-client';

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

## Why this package

tldr; It works with rollup

subscriptions-transport-ws works fine and it's better maintained so If you aren't having problems with it, you probably won't find much advantage in using this package. If you have tried to use that package with rollup however then you may have become frustrated and hopeless.

First you encounter the following error:

`[!] Error: 'SubscriptionClient' is not exported by node_modules/subscriptions-transport-ws/dist/index.js`

This you can fix by replacing the call to `commonjs()` with the following:

```
  commonjs({
      include: "node_modules/**",
      namedExports: {
        "node_modules/subscriptions-transport-ws/dist/index.js": [
          "SubscriptionClient"
        ]
      }
    }),
```

But then you discover that the package make reference to a lot of global variable that rollup doesn't know what to do with. So you add the builtins and globals plugins and try to build again and now you have "(!) `this` has been rewritten to `undefined`" and you think that doesn't sound right. You look it up and maybe it makes sense, but what to do now?

You may have slightly different results. I found that the imports from the graphql module were causing problems and that I didn't have much need for them. This module ends up being therefore much smaller and simpler, but one difference is that queries must be strings and it only uses native WebSocket, so you may end up with problems if you aren't targeting modern browsers.

## Warning

I have not used this with apollo-client, so I cannot garantee that it will work in that context just as well as subscription-transport-ws. Please raise an issue if you have problems.