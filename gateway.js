require('dotenv').config({ path: process.env.NODE_ENV ? `${__dirname}/envs/.env.${process.env.NODE_ENV}` : `${__dirname}/envs/.env.development` });
const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const compression = require('compression');
const proxy = require('express-http-proxy');
const url = require('url');
const winston = require('winston');
const async = require('async');
const request = require('request');
const jwt = require('express-jwt');
const path = require('path');
const cors = require('cors');

// Assorted helpers that are probably available in modules
// but for simple things it is best to avoid modules bloat!
const helpers = require('./libs/simple_helpers.js');

winston.transports.DailyRotateFile = require('winston-daily-rotate-file');

// Some vars for stats
let numberOfReceivedRequests = 0;

// Setup a logger
const logger = new winston.Logger({
  transports: [
    new(winston.transports.DailyRotateFile)({
      handleExceptions: false,
      json: true,
      level: 'debug',
      filename: path.join(__dirname, 'logs', 'Gateway-'),
      datePattern: 'yyyyMMdd.log',
      timestamp: true
    })
  ],
  exitOnError: false
});


// Express Setup
const app = express();

// This is the list of the available services,
// it's used for checking status and configuring the proxy
const existingServices = {
  Automovil: {
    host: 'localhost',
    port: '5005',
    serviceUp: false,
    lastChecked: null
  }
};

const allowedServices = ['Automoviles'];


const allowedRegistrationOrigins = ['localhost', '::ffff:127.0.0.1'];
const activeServices = {};

// Default to always return JSON from Microservices
app.use(/^\/(automoviles|status).*/, (req, res, next) => {
  res.set('Content-Type', 'application/json');
  next();
});

// Log all request
app.use((req, res, next) => {
  // Some accounting
  numberOfReceivedRequests += 1;
  logger.info(`Gateway: got request from: ${req.ip} route: '${req.originalUrl}' params: ${JSON.stringify(req.params)}`);
  next();
});
// Middlewares
app.use(express.static(path.join(__dirname, '/public')));
app.use(compression());

// Helmet!
// We allow sources only from this hosts
app.use(helmet.contentSecurityPolicy({
  directives: {
    defaultSrc: ["'self'"],
    styleSrc: ["'self'"]
  }
}));
// No DNS prefetch, comment line if we want to allow it.
app.use(helmet.dnsPrefetchControl());
// Xframe
app.use(helmet.frameguard({ action: 'sameorigin' }));
// Powered by
app.use(helmet.hidePoweredBy({ setTo: 'Microservices Framework' }));
// HTTPS Only -disable for now until we have more information on how this will be deployed-
/* app.use(helmet.hsts({
  maxAge: 5184000
})); */
// I.E. no-open
app.use(helmet.ieNoOpen());
// No sniff, there will be uploads in this app.
app.use(helmet.noSniff());
// XSS
app.use(helmet.xssFilter());
// Helmet!



app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cors());
app.disable('x-powered-by');


// Routes from here on @TODO move to module
app.get('/callback', (req, res) => {
  res.send({ loginOk: true });
});

// Proxy Routes to Microservices

app.use('/automoviles', proxy(`http://${existingServices.Automovil.host}:${existingServices.Automovil.port}`, {
  forwardPath: (req, res) => `/automoviles${url.parse(req.url).path}`
}));

app.get('/status', (req, res) => {
  const servicesStatus = [];
  async.each(
    Object.keys(existingServices),
    (anActiveService, asyncDone) => {
      request.get(`http://${existingServices[anActiveService].host}:${existingServices[anActiveService].port}/status`, (error, response, body) => {
        const err = false;
        if (error) {
          logger.info(`While checking status of service: '${anActiveService}' the Gateway was not able to reach it.`);
          logger.info(`Response during attempt to reach the service was: ${error}`);
          existingServices[anActiveService].serviceUp = false;
          existingServices[anActiveService].upTime = 0;
          existingServices[anActiveService].numberOfReceivedRequests = 0;
          servicesStatus.push({
            service: anActiveService,
            upTime: 0,
            serviceUp: false,
            lastSeen: existingServices[anActiveService].lastSeenOnline
          });
        } else {
          const parsedBody = JSON.parse(body);
          const upTime = helpers.formatedUptime(parsedBody.upTime);
          existingServices[anActiveService].serviceUp = true;
          existingServices[anActiveService].upTime = upTime;
          existingServices[anActiveService].numberOfReceivedRequests = parsedBody.numberOfReceivedRequests;
          existingServices[anActiveService].lastSeenOnline = new Date();
          servicesStatus.push({
            service: anActiveService,
            upTime: upTime,
            serviceUp: true,
            lastSeen: new Date(),
            numberOfRequests: parsedBody.numberOfReceivedRequests
          });
        }
        asyncDone(err);
      });
    },
    (error) => {
      if (error) {
        logger.info('Unknowen error while trying to get status of one of the services the Gateway was not able to reach it.');
        res.status(500).send({ error: 'Unknown error while getting status' });
      } else {
        res.send({
          totalServedRequests: numberOfReceivedRequests,
          upTime: helpers.formatedUptime(process.uptime()),
          servicesStatus: servicesStatus
        });
      }
    });
});


app.get('/serviceRegister/:serviceName/:serviceHost/:servicePort', (req, res) => {
  const { serviceName, serviceHost, servicePort } = req.params;

  if (allowedServices.indexOf(serviceName) === -1) {
    res.status(401).send({ error: 'Unknown Service.', registered: false });
  } else if (allowedRegistrationOrigins.indexOf(req.connection.remoteAddress) === -1) {
    logger.error(`Unauthorized Service Registrar: ${req.connection.remoteAddress}.`);
    res.status(401).send({ error: `Unauthorized Service Registrar: ${req.connection.remoteAddress}.`, registered: false });
  } else if (Object.prototype.hasOwnProperty.call(activeServices, serviceName)) {
    logger.error('Service already registered with Gateway.');
    res.status(400).send({ error: 'Service already registered with Gateway.', registered: true });
  } else {
    existingServices[serviceName].serviceUp = true;
    existingServices[serviceName].lastChecked = new Date();
    res.send({ service: req.params.serviceName, registered: true, error: null });
  }
});



console.log(`BOOTSTRAPING SERVICE USING ENVIRONMENT: '${process.env.NODE_ENV}'`);
app.listen(process.env.GATEWAY_PORT);
