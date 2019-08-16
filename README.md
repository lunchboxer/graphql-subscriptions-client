# graphql-subscriptions-client

This is based directly on the client from [subscriptions-transport-ws](https://github.com/apollographql/subscriptions-transport-ws). As the name suggests, it's only for use as a client. It uses native websockets to communicate with a graphql server which is using ['graphql-ws' protocol](https://github.com/apollographql/subscriptions-transport-ws/blob/master/PROTOCOL.md). It plays nice with rollup, too.

## Why this package

tldr; It works with rollup, and its lightweight

subscriptions-transport-ws works fine and it's better maintained so If you aren't having problems with it, you probably might want to use it instead. If you have tried to use that package with rollup however then you may have become frustrated and hopeless.

First you encounter the following error:

`[!] Error: 'SubscriptionClient' is not exported by node_modules/subscriptions-transport-ws/dist/index.js`

This you can fix by replacing the call to `commonjs()` with the following:

```javascript
  commonjs({
      include: "node_modules/**",
      namedExports: {
        "node_modules/subscriptions-transport-ws/dist/index.js": [
          "SubscriptionClient"
        ]
      }
    }),
```

But then you discover that the package makes reference to a lot of global variables that rollup doesn't know what to do with. So you add the builtins and globals plugins and try to build again and now you have "(!) `this` has been rewritten to `undefined`" and you think that doesn't sound right. You look it up and maybe it makes sense, but what to do now?

You may have slightly different results. I found that the imports from the graphql module were causing problems and that I didn't have much need for them. This module ends up being therefore much smaller and simpler, but one difference is that queries must be strings and it only uses native WebSocket, so you may end up with problems if you aren't targeting modern browsers.

### Subscriptions without apollo-client

I couldn't find any roll-your-own solutions that worked on the client for subscriptions. Making websockets work isn't difficult, but if you want automatic reconnection and a few other obvious necessities then it gets more complicated. This package includes them and not much more. You can use subscriptions without apollo-client at all. You can use it for all your graphql queries if you want, but using fetch instead is probably a better idea.

## Usage

If you have a apollo-server instance you can use this for subscriptions only, pass all requests over the websocket.

```js
import { SubscriptionClient } from 'graphql-subscriptions-client';

// get ready
const GRAPHQL_ENDPOINT = 'ws://localhost:3000/graphql';

const query = `subscription onNewItem {
        newItemCreated {
            id
        }
    }`

// set up the client, which can be reused
const client = new SubscriptionClient(GRAPHQL_ENDPOINT, {
  reconnect: true,
});

// make the actual request
client.request({query})

// the above doesn't do much though

// call subscription.unsubscribe() later to clean up
const subscription = client.request({query})
  // so lets actually do something with the response
  .subscribe({
    next ({data}) {
      if (data) {
        console.log('We got something!', data)
      }
    }
  })
```

Query must be a string.

## Warning

Don't use this with apollo-client. You'd really be defeating the purpose. If you are using apollo-client then maybe stick to their way of doings, so use subscriptions-transport-ws instead.
