import assert from 'node:assert/strict';
import { browserHostSocketURL } from '../src/network/BrowserHost.js';

assert.equal( browserHostSocketURL( 'https://gateway.example.test/base?x=1' ), 'wss://gateway.example.test/browser-host' );
assert.equal( browserHostSocketURL( 'http://localhost:5189' ), 'ws://localhost:5189/browser-host' );
assert.equal( browserHostSocketURL( 'ws://127.0.0.1:5200' ), 'ws://127.0.0.1:5200/browser-host' );
assert.throws( () => browserHostSocketURL( 'http://gateway.example.test' ), /HTTPS\/WSS/ );
assert.throws( () => browserHostSocketURL( 'ws://gateway.example.test' ), /HTTPS\/WSS/ );
console.log( 'Browser-host endpoint checks passed' );
