const request = require('request');
const BluePromise = require('bluebird');
const nodeSes = require('node-ses');

const Notifications = function Notifications(options) {
  this.SES = nodeSes.createClient({ key: options.sesKey, secret: options.sesSecret });
};

/*
Expects a literal object with the following values:
to:
from: (Use a setting?)
subject: 
message:
altText:
*/
Notifications.prototype.send = function sendNotification(options) {
  console.log('NOtification Sent..........');
  return true;
};


module.exports = Notifications;
