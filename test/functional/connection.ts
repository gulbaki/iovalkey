import * as net from "net";
import Redis from "../../lib/Redis";
import * as sinon from "sinon";
import { expect } from "chai";
import MockServer from "../helpers/mock_server";
import { StandaloneConnector } from "../../lib/connectors";
import { CONNECTION_CLOSED_ERROR_MSG } from "../../lib/utils";

describe("connection", function () {
  it('should emit "connect" when connected', (done) => {
    const redis = new Redis();
    redis.on("connect", function () {
      redis.disconnect();
      done();
    });
  });

  it('should emit "close" when disconnected', (done) => {
    const redis = new Redis();
    redis.once("end", done);
    redis.once("connect", function () {
      redis.disconnect();
    });
  });

  it("should send AUTH command before any other commands", (done) => {
    const redis = new Redis({ password: "123" });
    redis.get("foo");
    let times = 0;
    sinon.stub(redis, "sendCommand").callsFake((command) => {
      times += 1;
      if (times === 1) {
        expect(command.name).to.eql("auth");
      } else if (times === 2) {
        expect(command.name).to.eql("info");
      } else if (times === 3) {
        redis.disconnect();
        setImmediate(() => done());
      }
      return command.resolve("fake");
    });
  });

  it("should receive replies after connection is disconnected", (done) => {
    const redis = new Redis();
    redis.set("foo", "bar", function () {
      redis.stream.end();
    });
    redis.get("foo", function (err, res) {
      expect(res).to.eql("bar");
      redis.disconnect();
      done();
    });
  });

  it("connects successfully immediately after end", (done) => {
    const redis = new Redis();
    redis.once("end", async () => {
      await redis.connect();
      done();
    });

    redis.quit();
  });

  it("connects successfully immediately after quit", (done) => {
    const redis = new Redis();
    redis.once("end", async () => {
      await redis.connect();
      done();
    });

    // process.nextTick ensures the connection is being made.
    process.nextTick(() => {
      redis.quit();
    });
  });

  describe("connectTimeout", () => {
    it("should clear the timeout when connected", (done) => {
      const connectTimeout = 10000;
      const redis = new Redis({ connectTimeout });
      let set = false;

      // TODO: use spy
      const stub = sinon
        .stub(net.Socket.prototype, "setTimeout")
        // @ts-expect-error
        .callsFake((timeout) => {
          if (timeout === connectTimeout) {
            set = true;
            return;
          }
          expect(set).to.eql(true);
          expect(timeout).to.eql(0);
          stub.restore();
          redis.disconnect();
          done();
        });
    });

    it("should ignore timeout if connect", (done) => {
      const redis = new Redis({
        port: 6379,
        connectTimeout: 500,
        retryStrategy: null,
      });
      let isReady = false;
      let timeoutCalled = false;

      // TODO: use spy
      sinon
        .stub(net.Socket.prototype, "setTimeout")
        // @ts-expect-error
        .callsFake((timeout, callback) => {
          if (timeout === 0) {
            if (!isReady) {
              isReady = true;
            } else {
              timeoutCalled = true;
            }
            return;
          }

          setTimeout(() => {
            callback();
            expect(timeoutCalled).to.eql(false);
            redis.disconnect();
            done();
          }, timeout);
        });
    });
  });

  describe("#connect", function () {
    it("should return a promise", (done) => {
      let pending = 2;
      const redis = new Redis({ lazyConnect: true });
      redis.connect().then(function () {
        redis.disconnect();
        if (!--pending) {
          done();
        }
      });

      const redis2 = new Redis(6390, {
        lazyConnect: true,
        retryStrategy: null,
      });
      redis2.connect().catch(function () {
        if (!--pending) {
          redis2.disconnect();
          done();
        }
      });
    });

    it("should stop reconnecting when disconnected", (done) => {
      const redis = new Redis(8999, {
        retryStrategy: function () {
          return 0;
        },
      });

      redis.on("close", function () {
        redis.disconnect();
        sinon
          .stub(Redis.prototype, "connect")
          .throws(new Error("`connect` should not be called"));
        setTimeout(function () {
          Redis.prototype.connect.restore();
          done();
        }, 1);
      });
    });

    it("should reject when connected", (done) => {
      const redis = new Redis();
      redis.connect().catch(function (err) {
        expect(err.message).to.match(/Redis is already connecting/);
        redis.disconnect();
        done();
      });
    });

    it("should resolve when the status become ready", (done) => {
      const redis = new Redis({ lazyConnect: true });
      redis.connect().then(function () {
        expect(redis.status).to.eql("ready");
        redis.disconnect();
        done();
      });
    });

    it("should reject when closed (reconnecting)", (done) => {
      const redis = new Redis({
        port: 8989,
        lazyConnect: true,
        retryStrategy: function () {
          return 0;
        },
      });

      redis.connect().catch(function () {
        expect(redis.status).to.eql("reconnecting");
        redis.disconnect();
        done();
      });
    });

    it("should reject when closed (end)", (done) => {
      const redis = new Redis({
        port: 8989,
        lazyConnect: true,
        retryStrategy: null,
      });

      redis.connect().catch(function () {
        expect(redis.status).to.eql("end");
        redis.disconnect();
        done();
      });
    });

    it("should close if socket destroyed before being returned", (done) => {
      const message = "instant error";
      sinon.stub(net, "createConnection").callsFake(function () {
        const socket = (net.createConnection as any).wrappedMethod.apply(
          net,
          arguments
        ) as net.Socket;
        socket.destroy(new Error(message));
        return socket;
      });

      let closed = false;
      let errored = false;

      const redis = new Redis({ lazyConnect: true });
      redis
        .connect(() => {})
        .catch((err) => {
          expect(closed).to.equal(true);
          expect(err.message).to.eql(CONNECTION_CLOSED_ERROR_MSG);
          redis.disconnect();
          done();
        });

      redis.on("error", (err) => {
        expect(err.message).to.equal(message);
        errored = true;
      });
      redis.on("close", () => {
        expect(errored).to.equal(true);
        closed = true;
      });
    });
  });

  describe("retryStrategy", function () {
    it("should pass the correct retry times", (done) => {
      let t = 0;
      new Redis({
        port: 1,
        retryStrategy: function (times) {
          expect(times).to.eql(++t);
          if (times === 3) {
            done();
            return;
          }
          return 0;
        },
      });
    });

    it("should skip reconnecting when retryStrategy doesn't return a number", (done) => {
      var redis = new Redis({
        port: 1,
        retryStrategy: function () {
          process.nextTick(function () {
            expect(redis.status).to.eql("end");
            redis.disconnect();
            done();
          });
          return null;
        },
      });
    });

    it("should skip reconnecting if quitting before connecting", (done) => {
      let count = 0;
      const redis = new Redis({
        port: 8999,
        retryStrategy: function () {
          count++;
        },
      });

      redis.quit().then(function (result) {
        expect(result).to.eql("OK");
        expect(count).to.eql(0);
        redis.disconnect();
        done();
      });
    });

    it("should skip reconnecting if quitting before connecting (buffer)", (done) => {
      const redis = new Redis({
        port: 8999,
        retryStrategy: function () {
          throw new Error("should not reconnect");
        },
      });

      redis.quitBuffer().then(function (result) {
        expect(result).to.be.instanceof(Buffer);
        expect(result.toString()).to.eql("OK");
        redis.disconnect();
        done();
      });
    });
  });

  describe("connectionName", function () {
    it("should name the connection if options.connectionName is not null", (done) => {
      const redis = new Redis({ connectionName: "niceName" });
      redis.once("ready", function () {
        redis.client("getname", function (err, res) {
          expect(res).to.eql("niceName");
          redis.disconnect();
          done();
        });
      });
      redis.set("foo", 1);
    });

    it("should set the name before any subscribe command if reconnected", (done) => {
      const redis = new Redis({ connectionName: "niceName" });
      redis.once("ready", function () {
        redis.subscribe("l", function () {
          redis.disconnect(true);
          redis.unsubscribe("l", function () {
            redis.client("getname", function (err, res) {
              expect(res).to.eql("niceName");
              redis.disconnect();
              done();
            });
          });
        });
      });
    });
  });

  describe("readOnly", function () {
    it("should send readonly command before other commands", (done) => {
      let called = false;
      const redis = new Redis({
        port: 30001,
        readOnly: true,
        showFriendlyErrorStack: true,
      });
      var node = new MockServer(30001, function (argv) {
        if (argv[0] === "readonly") {
          called = true;
        } else if (argv[0] === "get" && argv[1] === "foo") {
          expect(called).to.eql(true);
          redis.disconnect();
          node.disconnect(function () {
            done();
          });
        }
      });
      redis.get("foo").catch(function () {});
    });
  });

  describe("autoResendUnfulfilledCommands", function () {
    it("should resend unfulfilled commands to the correct db when reconnected", (done) => {
      const redis = new Redis({ db: 3 });
      const pub = new Redis({ db: 3 });
      redis.once("ready", function () {
        let pending = 2;
        redis.blpop("l", 0, function (err, res) {
          expect(res[0]).to.eql("l");
          expect(res[1]).to.eql("1");
          if (!--pending) {
            redis.disconnect();
            done();
          }
        });
        redis.set("foo", "1");
        redis
          .pipeline()
          .incr("foo")
          .exec(function (err, res) {
            expect(res[0][1]).to.eql(2);
            if (!--pending) {
              done();
            }
          });
        setTimeout(function () {
          redis.stream.end();
        }, 0);
      });
      redis.once("close", function () {
        pub.lpush("l", 1);
      });
    });

    it("should resend previous subscribes before sending unfulfilled commands", (done) => {
      const redis = new Redis({ db: 4 });
      const pub = new Redis({ db: 4 });
      redis.once("ready", function () {
        pub.pubsub("channels", function (err, channelsBefore) {
          redis.subscribe("l", function () {
            redis.disconnect(true);
            redis.unsubscribe("l", function () {
              pub.pubsub("channels", function (err, channels) {
                expect(channels.length).to.eql(channelsBefore.length);
                redis.disconnect();
                done();
              });
            });
          });
        });
      });
    });
  });

  describe("sync connection", () => {
    it("works when connection established before promise is resolved", (done) => {
      const socket = new net.Socket();
      sinon.stub(StandaloneConnector.prototype, "connect").resolves(socket);
      socket.connect(6379, "127.0.0.1").on("connect", () => {
        new Redis().on("connect", () => done());
      });
    });

    it("ignores connectTimeout when connection established before promise is resolved", (done) => {
      const socketSetTimeoutSpy = sinon.spy(net.Socket.prototype, "setTimeout");
      const socket = new net.Socket();
      sinon.stub(StandaloneConnector.prototype, "connect").resolves(socket);
      socket.connect(6379, "127.0.0.1").on("connect", () => {
        const redis = new Redis({
          connectTimeout: 1,
        });
        redis.on("error", () =>
          done(new Error("Connect timeout should not have been called"))
        );
        redis.on("connect", () => {
          expect(socketSetTimeoutSpy.callCount).to.eql(0);
          done();
        });
      });
    });
  });

  describe("multiple reconnect", function () {
    it("should reconnect after multiple consecutive disconnect(true) are called", (done) => {
      const redis = new Redis();
      redis.once("reconnecting", function () {
        redis.disconnect(true);
      });
      redis.once("ready", function () {
        redis.disconnect(true);
        const rejectTimeout = setTimeout(function () {
          redis.disconnect();
          done(new Error("second disconnect(true) didn't reconnect redis"));
        }, 1000);
        process.nextTick(function () {
          redis.once("ready", function () {
            clearTimeout(rejectTimeout);
            redis.disconnect();
            done();
          });
        });
      });
    });
  });
});

describe("disconnection", function () {
  it("emits an error if select is not allowed", (done) => {
    const errMessage = "select is not allowed";
    const node = new MockServer(30001, function (argv) {
      if (argv[0] === "select") {
        return new Error(errMessage);
      }
    });
    const redis = new Redis({ port: 30001, db: 2 });
    redis.on("error", (err) => {
      if (err.message === errMessage) {
        redis.disconnect();
        node.disconnect(() => {
          done();
        });
      }
    });
  });
});
