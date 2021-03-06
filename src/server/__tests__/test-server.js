describe('Server', () => {
    jest.mock('fs');
    const fs = require('fs');

    jest.mock('http');
    const http = require('http');

    jest.mock('https');
    const https = require('https');

    const ProxyServer = require('http-proxy');

    const {
        createApps,
        App,
    } = require('../app');
    const Metrics = require('../metrics/metrics');
    const {MetricCounter} = require('../metrics');

    jest.unmock('../server');
    const {Server} = require('../server');

    let metrics, server;
    const apps = {
        app1: new App(),
        app2: new App(),
    };
    it('listens as a http server', () => {
        createApps.mockReturnValue(apps);

        metrics = new MetricCounter({
            prometheus: {
                path: '/metrics',
            },
        });

        server = new Server({
            server: {
                host: 'localhost',
                port: 8080,
            },
        }, metrics);

        expect(server.server instanceof http.Server).toBe(true);

        expect(server.server.listen).toBeCalled();

        const call = server.server.listen.mock.calls[0];
        expect(call[0]).toEqual({
            host: 'localhost',
            port: 8080,
        });

        const onListen = call[1];
        server.server.address.mockReturnValueOnce({
            address: '127.0.0.1',
            port: 8080,
        });
        onListen();
    });

    pit('routes request by router', () => {
        const req = new http.IncomingMessage();
        req.method = 'GET';
        req.url = '/';
        req.headers = {
            host: 'app.example.com',
        };
        req.socket = {
            remoteAddress: '127.0.0.10',
        };
        const res = new http.ServerResponse();

        server.router.route.mockReturnValueOnce(Promise.resolve({
            app: 'app1',
            target: 'http://127.0.0.1:8001',
        }));

        http
            .Server
            .mock
            .calls[0][0](req, res);

        expect(server.router.route)
            .toBeCalledWith({
                host: 'app.example.com',
                url: '/',
                method: 'GET',
                remote: '127.0.0.10',
            });

        return Promise.resolve();
    });

    pit('calls app.handle', () =>
        Promise.resolve()
            .then(() => {
                expect(apps.app1.handle).toBeCalled();
            })
    );

    it('counts requests', () => {
        expect(metrics.increment).toBeCalledWith(Metrics.ProxyRequest, {
            app: 'app1',
            host: 'app.example.com',
            target: 'http://127.0.0.1:8001',
            public: false,
        });

        expect(metrics.increment).toBeCalledWith(Metrics.InboundRequest, {
            host: 'app.example.com',
            method: 'GET',
        });
    });

    let proxy;
    it('calls proxy after authorized', () => {
        expect(ProxyServer.mock.instances.length).toBe(1);
        proxy = ProxyServer.mock.instances[0];

        server
            .apps
            .app1
            .handle
            .mock
            .calls[0][2]();
        expect(proxy.web).toBeCalled();
    });

    pit('responses 404 if route does not found', () => {
        const req = new http.IncomingMessage();
        req.url = '/';
        req.headers = {
            host: 'app.example.com',
        };
        const res = new http.ServerResponse();

        server.router.route.mockReturnValueOnce(Promise.resolve(null));

        http
            .Server
            .mock
            .calls[0][0](req, res);

        return Promise.resolve()
            .then(() => {
                expect(res.writeHead).toBeCalledWith(404);
                expect(res.end).toBeCalledWith('Not Found');
            });
    });

    pit('proxies WebSocket when upgrad requested', () => {
        proxy.ws.mockClear();

        const req = new http.IncomingMessage();
        req.url = '/';
        req.headers = {
            host: 'app.example.com',
        };
        const socket = 'socket';
        const head = 'head';

        server.router.route.mockReturnValueOnce(Promise.resolve({
            app: 'app1',
            target: 'http://ws.example.com',
        }));

        server
            .server
            .on
            .mock
            .calls
            .filter((call) => call[0] === 'upgrade')
            .forEach((call) => call[1](req, socket, head));

        return Promise.resolve()
            .then(() =>
                Promise.resolve().then(() =>
                    Promise.resolve()
                        .then(() => {
                            expect(proxy.ws).toBeCalled();
                        })
                )
            );
    });

    pit('sets cors flag', () => {
        const req = new http.IncomingMessage();
        req.headers = {
            host: 'app1.example.com',
            origin: 'http://app2.example.com',
        };

        server.router.route.mockReturnValueOnce(Promise.resolve({
            app: 'app1',
            target: 'http://localhost:8001',
        }));
        server.router.route.mockReturnValueOnce(Promise.resolve({
            app: 'app2',
            target: 'http://localhost:8002',
        }));

        return server.resolveRoute(req)
            .then(() => {
                expect(req.cors).toBe(true);
            });
    });

    pit('does not set CORS flag to external origin', () => {
        const req = new http.IncomingMessage();
        req.headers = {
            host: 'app1.example.com',
            origin: 'http://external.example.com',
        };

        server.router.route.mockReturnValueOnce(Promise.resolve({
            app: 'app1',
            target: 'http://localhost:8001',
        }));
        server.router.route.mockReturnValueOnce(Promise.resolve(null));

        return server.resolveRoute(req)
            .then(() => {
                expect(req.cors).not.toBe(true);
            });
    });

    it('sets CORS headers', () => {
        const req = new http.IncomingMessage();
        req.headers = {
            host: 'app1.example.com',
            origin: 'http://app2.example.com',
        };
        const res = new http.ServerResponse();
        const proxyRes= new http.ServerResponse();

        req.cors = true;

        server.onProxyRes(proxyRes, req, res);

        let calls = res.setHeader.mock.calls;
        expect(calls.length).toBe(2);
        expect(calls).toEqual([
            ['Access-Control-Allow-Credentials', 'true'],
            ['Access-Control-Allow-Origin', 'http://app2.example.com'],
        ]);
    });

    it('does not set CORS headers to external origin', () => {
        const req = new http.IncomingMessage();
        req.headers = {
            host: 'app1.example.com',
            origin: 'http://external.example.com',
        };
        const res = new http.ServerResponse();
        const proxyRes= new http.ServerResponse();

        req.cors = false;

        proxyRes.setHeader.mockClear();

        server.onProxyRes(proxyRes, req, res);

        expect(res.setHeader).not.toBeCalled();
    });

    it('forwards user id', () => {
        const proxyReq= new http.ClientRequest();
        const req = new http.IncomingMessage();
        const res = new http.ServerResponse();

        req.user = {
            id: 'user-id',
            name: 'user-name',
        };

        proxyReq.setHeader.mockClear();

        server.onProxyReq(proxyReq, req, res);

        expect(proxyReq.setHeader)
            .toBeCalledWith('X-Forwarded-User', 'user-id');
    });

    it('removes header of user id if unauthorized', () => {
        const proxyReq= new http.ClientRequest();
        const req = new http.IncomingMessage();
        const res = new http.ServerResponse();

        req.user = {};

        proxyReq.setHeader.mockClear();
        proxyReq.removeHeader.mockClear();

        server.onProxyReq(proxyReq, req, res);

        expect(proxyReq.setHeader).not.toBeCalled();
        expect(proxyReq.removeHeader)
            .toBeCalledWith('X-Forwarded-User');
    });

    pit('sets public flag', () => {
        const req = new http.IncomingMessage();
        const res = new http.ServerResponse();

        req.headers = {
            host: 'app1.example.com',
        };

        server.router.route.mockReturnValueOnce(Promise.resolve({
            app: 'app1',
            target: 'http://localhost:8001',
            public: true,
        }));

        return server
            .onRequest(req, res)
            .then(() => {
                expect(req.public).toBe(true);
            });
    });


    it('listens as a https server', () => {
        const filedata = new Buffer([]);
        fs.readFileSync.mockReturnValue(filedata);

        const httpsServer = new Server({
            server: {
                host: 'localhost',
                port: 8080,
            },
            sslServer: {
                host: 'localhost',
                port: 8443,
            },
            ssl: {
                key: 'key.pem',
                cert: 'cert.pem',
            },
        });

        expect(httpsServer.server instanceof http.Server).toBe(true);
        expect(httpsServer.httpsServer instanceof https.Server).toBe(true);
        expect(https.Server).toBeCalled();
        expect(https.Server.mock.calls[0][0]).toEqual({
            key: filedata,
            cert: filedata,
        });
        expect(httpsServer.httpsServer.listen).toBeCalled();
        expect(httpsServer.httpsServer.listen.mock.calls[0][0]).toEqual({
            host: 'localhost',
            port: 8443,
        });
    });

    pit('responds 500 if errored', () => {
        const req = new http.IncomingMessage();
        req.headers = {};
        const res = new http.ServerResponse();
        const e = new Error('Error for test');

        server.router.route.mockReturnValueOnce(Promise.reject(e));

        return server.onRequest(req, res)
            .then(() => {
                expect(res.statusCode).toBe(500);
            })
            .then(() => {
                const req2 = new http.IncomingMessage();

                // Cause error
                req2.headers = null;

                const res2 = new http.ServerResponse();

                server.router.route.mockReturnValueOnce(Promise.resolve({}));

                return server.onRequest(req2, res2);
            })
            .then(() => {
                expect(res.statusCode).toBe(500);
            });
    });
});
