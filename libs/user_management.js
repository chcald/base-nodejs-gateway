const request = require('request');
const BluePromise = require('bluebird');
const Async = require('async');
const uuid = require('uuid');
const ses = require('node-ses');
const mongoose = require('mongoose');
mongoose.Promise = require('bluebird');

const Schema = mongoose.Schema;
const passwordResetToken = new Schema({
  email: { type: String },
  token: { type: String },
  generated_on: { type: Number },
  expiration: { type: Number },
  used: { type: Boolean, default: false },
  used_on: { type: Number },
  auth0_user_id: { type: String }
}, { collection: 'password_reset_token' });

const Model = mongoose.model('PasswordResetToken', passwordResetToken);
const dbConnectionOptions = {
  db: { native_parser: true },
  server: { poolSize: process.env.DB_POOL_SIZE },
  user: '',
  pass: ''
};
mongoose.connect(`mongodb://${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_SCHEMA}`, dbConnectionOptions).then((result) => {}).catch((reason) => {});


/*
  Note: this process should use a producers/consumers architecture but
  given that this is going to be used only once and to avoid adding more
  components to the infrastructure we'll just implement it as a simple object.
  If this is going to be used on a daily basis we need to implement it
  as stated above!
*/
const UserManagement = function UserManagementConstructor(options) {
  this.auth0ManagementClientId = options.auth0ManagementClientId;
  this.auth0ManagementClientSecret = options.auth0ManagementClientSecret;
  this.auth0ManagementToken = null;
  this.auth0TokenType = null;
  this.usersToImport = options.usersToImport;
  this.importedUsers = [];
  this.notImportedUsers = [];
  // We want to keep audits for this...
  this.Model = Model;
};

UserManagement.prototype.connect = function getManagementToken() {
  const requestOptions = {
    url: `https://${process.env.AUHT0_SUBDOMAIN}.auth0.com/oauth/token`,
    method: 'POST',
    json: {
      grant_type: 'client_credentials',
      audience: 'https://pabloglo.auth0.com/api/v2/',
      client_id: this.auth0ManagementClientId,
      client_secret: this.auth0ManagementClientSecret
    }
  };

  return new BluePromise((resolve, reject) => {
    request(requestOptions, (error, response, body) => {
      if (error || response.statusCode !== 200) {
        const reason = new Error();
        reason.message = body.error;
        reject(reason);
      } else {
        this.auth0ManagementToken = body.access_token;
        this.auth0TokenType = body.token_type;
        resolve({ success: true });
      }
    });
  });
};



UserManagement.prototype.createUsers = function createUsers() {
  // New execution, clear this lists
  this.notImportedUsers = [];
  this.importedUsers = [];
  return new BluePromise((resolve, reject) => {
    Async.eachLimit(
      this.usersToImport,
      5,
      (aUser, asyncCallback) => {
        // Payload
        const payload = aUser;
        payload.connection = 'Username-Password-Authentication'; //@TODO move to config setting
        payload.email_verified = true;
        payload.verify_email = true;
        payload.password = uuid.v4();

        const createUserOptions = {
          url: `https://${process.env.AUHT0_SUBDOMAIN}.auth0.com/api/v2/users`,
          headers: {
            'Authorization': `${this.auth0TokenType} ${this.auth0ManagementToken}`,
            'Content-Type': 'application/json'
          },
          json: aUser,
          method: 'POST'
        };
        request(createUserOptions, (error, response, body) => {
          if (error || response.statusCode !== 201) {
            this.notImportedUsers.push({ email: aUser.email, reason: body.message });
          } else {
            this.importedUsers.push({ email: aUser.email, auth0User: body });
          }
          asyncCallback();
        });
      },
      (error) => {
        resolve({ importedUsers: this.importedUsers, rejectedUsers: this.notImportedUsers });
      });
  });
};

// Gets a Token, returns a User Reset record
UserManagement.prototype.validatePasswordResetToken = function validatePasswordResetToken(token) {
  return new BluePromise((resolve, reject) => {
    this.Model.findOne({
      token: token,
      used: false
    }).exec().then((tokenResult) => {
      if (!tokenResult) {
        return reject(new Error('_invalid_token_'));
      } else {
        const now = Math.floor(new Date().getTime() / 1000);
        const tokenAge = now - tokenResult.expiration;
        const tokenHasExpired = tokenAge > 0 ? true : false;
        return resolve({ tokenResult, now, tokenAge, tokenHasExpired });
      }
    });
  });
};

// Gets a token and a password, if token is valid sets the password and updates the token if not valid updates the token only
UserManagement.prototype.setNewPassword = function setNewPassword(token, newPassword) {
  const processState = {};
  return new BluePromise((resolve, reject) => {
    if (!token || !newPassword) {
      return reject(new Error('_missing_token_or_password_'));
    } else {
      this.validatePasswordResetToken(token)
        .then((tokenStatus) => {
          if (tokenStatus.tokenHasExpired) {
            this.updateTokenRecord(token)
              .then((tokenUpdateStatus) => {
                return reject(new Error('_token_has_expired_'));
              })
              .catch((reason) => {
                return reject(reason);
              });
          } else {
            // Set Auth0 Password
            return this.setAuth0Password(tokenStatus.tokenResult.auth0_user_id, newPassword)
              .then((auth0PasswordUpdateResult) => {
                processState.auth0PasswordUpdateResult = auth0PasswordUpdateResult;
                // Update Token
                return this.updateTokenRecord(tokenStatus.tokenResult.token);
              })
              .then((tokenUpdateStatus) => {
                return resolve({ tokenUpdateStatus: tokenUpdateStatus, auth0PasswordUpdateResult: processState.auth0PasswordUpdateResult });
              })
              .catch((reason) => {
                return reject(reason);
              });
          }
        }).catch((reason) => {
          return reject(reason);
        });
    }
  });
};

UserManagement.prototype.setAuth0Password = function setAuth0Password(auth0UserId, password) {
  return new BluePromise((resolve, reject) => {
    const changePasswordOptions = {
      url: `https://${process.env.AUHT0_SUBDOMAIN}.auth0.com/api/v2/users/${auth0UserId}`,
      headers: {
        'Authorization': `${this.auth0TokenType} ${this.auth0ManagementToken}`,
        'Content-Type': 'application/json'
      },
      json: { password: password },
      method: 'PATCH'
    };
    request(changePasswordOptions, (error, response, body) => {
      if (error || response.statusCode !== 200) {
        const reason = new Error();
        reason.message = body.error;
        return reject(reason);
      } else {
        return resolve({ success: true, auth0_result: body });
      }
    });
  });
};

UserManagement.prototype.updateTokenRecord = function updateTokenRecord(token) {
  return new BluePromise((resolve, reject) => {
    this.Model
      .update({
        token: token,
        used: false
      }, { used: true, used_on: Math.floor(new Date().getTime() / 1000) }, {})
      .exec()
      .then((saveResult) => {
        return resolve(saveResult);
      })
      .catch((reason) => {
        return reject(reason);
      });
  });
};


// TO BE MOVED TO NOTIFICATIONS SERVICE
UserManagement.prototype.getNotificationTemplate = function renderTemplate(template, target) {
  const EmailTemplate = require('email-templates').EmailTemplate;
  return new BluePromise((resolve, reject) => {
    const templateDir = `${__dirname}/../email_templates/${template}`;
    const resetPasswordEmail = new EmailTemplate(templateDir);
    const templateVars = { resetLink: target.resetLink, firstName: target.userMetadata.first_name, lastName: target.userMetadata.last_name, pageTitle: 'Cambiar Contraseña' };
    resetPasswordEmail.render(templateVars, (err, result) => {
      if (err) {
        return reject(err);
      } else {
        return resolve(result);
      }
    });
  });
};

UserManagement.prototype.sendMail_WORKING_ORIGINAL = function sendMail(target) {
  const EmailTemplate = require('email-templates').EmailTemplate;
  const sesClient = ses.createClient({ key: `${process.env.AWS_SES_KEY}`, secret: `${process.env.AWS_SES_SECRET}` });
  return new BluePromise((resolve, reject) => {
    const templateDir = `${__dirname}/../email_templates/password_reset`;
    const resetPasswordEmail = new EmailTemplate(templateDir);
    const userDetails = { resetLink: target.resetLink, firstName: target.userMetadata.first_name, lastName: target.userMetadata.last_name, pageTitle: 'Cambiar Contraseña' };
    resetPasswordEmail.render(userDetails, (err, result) => {
      sesClient.sendEmail({
        to: target.email,
        from: 'ordertaking-noreply@imscorporate.com',
        subject: 'Password Change Request', //@TODO move to setting?
        message: result.html,
        altText: result.text
      }, (err, data, res) => {
        if (err) {
          const error = new Error();
          error.message = err.Message;
          return reject(error);
        } else {
          return resolve({ emailSent: true, target: target.email, emailTemplates: result, sesError: null });
        }
      });
    });
  });
};


UserManagement.prototype.sendMail = function sendMail(target, notificationType) {
  const sesClient = ses.createClient({ key: `${process.env.AWS_SES_KEY}`, secret: `${process.env.AWS_SES_SECRET}` });
  return new BluePromise((resolve, reject) => {
    this.getNotificationTemplate(notificationType, target).then((template) => {
      sesClient.sendEmail({
        to: target.email,
        from: 'ordertaking-noreply@imscorporate.com',
        subject: 'Password Change Request', //@TODO move to setting?
        message: template.html,
        altText: template.text
      }, (err, data, res) => {
        if (err) {
          const error = new Error();
          error.message = err.Message;
          return reject(error);
        } else {
          return resolve({ emailSent: true, target: target.email, emailTemplates: template, sesError: null });
        }
      });
    });
  });
};

// TO BE MOVED TO NOTIFICATIONS SERVICE

UserManagement.prototype.sendPasswordRestEmails = function sendPasswordResetLInk(importedUsers) {
  return new BluePromise((resolve, reject) => {
    const getResetTokensForUsers = [];
    const sendResetMails = [];
    // Queue all token generations
    importedUsers.forEach((anImportedUser) => {
      getResetTokensForUsers.push(this.generateResetLink(anImportedUser));
    });

    // Wait for all enqueued token generations to resolve
    BluePromise.all(getResetTokensForUsers)
      .then((resetTokens) => {
        resetTokens.forEach(aResetToken => sendResetMails.push(this.sendMail(aResetToken, 'new_user_set_password')));
        BluePromise.all(sendResetMails).then((emailsSent) => {
          return resolve(emailsSent);
        }).catch((reason) => {
          return reject(reason);
        });
      });
  });
};

UserManagement.prototype.resetPassword = function resetPassword(userEmail) {
  return new BluePromise((resolve, reject) => {
    const changePasswordOptions = {
      url: `https://${process.env.AUHT0_SUBDOMAIN}.auth0.com/api/v2/users?q=email=${userEmail}`,
      headers: {
        'Authorization': `${this.auth0TokenType} ${this.auth0ManagementToken}`,
        'Content-Type': 'application/json'
      },
      method: 'GET'
    };
    request(changePasswordOptions, (error, response, body) => {
      if (error || response.statusCode !== 200) {
        const reason = new Error();
        reason.message = error || body;
        return reject(reason);
      } else {
        // Auth0 doesn't supports exact match so we need to filter ourselves
        const targetUser = { email: userEmail };
        targetUser.auth0User = JSON.parse(body).filter(aUser => aUser.email === userEmail).pop();
        this.generateResetLink(targetUser)
          .then((resetRecord) => {
            return this.sendMail(resetRecord, 'password_reset');
          })
          .then((sendMailResult) => {
            //console.log(sendMailResult);
            return resolve(sendMailResult);
          })
          .catch((reason) => {
            const error = new Error();
            error.message = reason;
            return reject(error);
          });
      }
    });
  });
};

UserManagement.prototype.generateResetLink = function generateResetLink(user) {
  return new BluePromise((resolve, reject) => {
    const now = new Date();
    now.setDate(now.getDate() + 1);
    const expiration = Math.floor(now.getTime() / 1000);

    const resetToken = uuid.v4();

    const passwordResetRecord = {
      email: user.email,
      token: resetToken,
      generated_on: Math.floor(new Date().getTime() / 1000),
      expiration: expiration,
      used: false,
      used_on: null,
      auth0_user_id: user.auth0User.user_id
    };

    const newPasswordResetRecord = new this.Model(passwordResetRecord);
    newPasswordResetRecord.save((error) => {
      if (error) {
        reject(error);
      } else {
        resolve({ resetLink: `http://localhost:8080/password-change/${resetToken}`, userMetadata: user.auth0User.user_metadata, email: user.email });
      }
    });
  });
};



module.exports = UserManagement;
