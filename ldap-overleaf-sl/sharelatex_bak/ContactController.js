const UserHandler = require('./UserHandler')
const UserDeleter = require('./UserDeleter')
const UserGetter = require('./UserGetter')
const { User } = require('../../models/User')
const NewsletterManager = require('../Newsletter/NewsletterManager')
const logger = require('@overleaf/logger')
// >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
// TODO(ldap)
//const { Client } = require('ldapts')
// <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<

const metrics = require('@overleaf/metrics')
const AuthenticationManager = require('../Authentication/AuthenticationManager')
const SessionManager = require('../Authentication/SessionManager')
const Features = require('../../infrastructure/Features')
const UserAuditLogHandler = require('./UserAuditLogHandler')
const UserSessionsManager = require('./UserSessionsManager')
const UserUpdater = require('./UserUpdater')
const Errors = require('../Errors/Errors')
const HttpErrorHandler = require('../Errors/HttpErrorHandler')
const OError = require('@overleaf/o-error')
const EmailHandler = require('../Email/EmailHandler')
const UrlHelper = require('../Helpers/UrlHelper')
const { promisify, callbackify } = require('util')
const { expressify } = require('@overleaf/promise-utils')
const {
  acceptsJson,
} = require('../../infrastructure/RequestContentTypeDetection')
const Modules = require('../../infrastructure/Modules')
const OneTimeTokenHandler = require('../Security/OneTimeTokenHandler')

async function _sendSecurityAlertClearedSessions(user) {
  const emailOptions = {
    to: user.email,
    actionDescribed: `active sessions were cleared on your account ${user.email}`,
    action: 'active sessions cleared',
  }
  try {
    await EmailHandler.promises.sendEmail('securityAlert', emailOptions)
  } catch (error) {
    // log error when sending security alert email but do not pass back
    logger.error(
      { error, userId: user._id },
      'could not send security alert email when sessions cleared'
    )
  }
}

// >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
  // TODO(ldap)
  //const ldapcontacts = getLdapContacts(contacts)
  //contacts.push(ldapcontacts)
// <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<

function _sendSecurityAlertPasswordChanged(user) {
  const emailOptions = {
    to: user.email,
    actionDescribed: `your password has been changed on your account ${user.email}`,
    action: 'password changed',
  }
  EmailHandler.promises
    .sendEmail('securityAlert', emailOptions)
    .catch(error => {
      // log error when sending security alert email but do not pass back
      logger.error(
        { error, userId: user._id },
        'could not send security alert email when password changed'

// >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
// TODO(ldap)
// async function getLdapContacts(contacts) {
//   if (
//     process.env.LDAP_CONTACTS === undefined ||
//     !(process.env.LDAP_CONTACTS.toLowerCase() === 'true')
//   ) {
//     return contacts
//   }
//   const client = new Client({
//     url: process.env.LDAP_SERVER,
//   })

//   // if we need a ldap user try to bind
//   if (process.env.LDAP_BIND_USER) {
//     try {
//       await client.bind(process.env.LDAP_BIND_USER, process.env.LDAP_BIND_PW)
//     } catch (ex) {
//       console.log('Could not bind LDAP reader user: ' + String(ex))
//     }
//   }

//   const ldap_base = process.env.LDAP_BASE
//   // get user data
//   try {
//     // if you need an client.bind do it here.
//     const { searchEntries, searchReferences } = await client.search(ldap_base, {
//       scope: 'sub',
//       filter: process.env.LDAP_CONTACT_FILTER,
//     })
//     await searchEntries
//     for (var i = 0; i < searchEntries.length; i++) {
//       var entry = new Map()
//       var obj = searchEntries[i]
//       entry['_id'] = undefined
//       entry['email'] = obj['mail']
//       entry['first_name'] = obj['givenName']
//       entry['last_name'] = obj['sn']
//       entry['type'] = 'user'
//       // Only add to contacts if entry is not there.
//       if (contacts.indexOf(entry) === -1) {
//         contacts.push(entry)
//       }
//     }
//   } catch (ex) {
//     console.log(String(ex))
//   } finally {
//     // console.log(JSON.stringify(contacts))
//     // even if we did not use bind - the constructor of
//     // new Client() opens a socket to the ldap server
//     client.unbind()
//     return contacts
//   }
// }
// <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
      )
    })
}

async function _ensureAffiliation(userId, emailData) {
  if (emailData.samlProviderId) {
    await UserUpdater.promises.confirmEmail(userId, emailData.email)
  } else {
    await UserUpdater.promises.addAffiliationForNewUser(userId, emailData.email)
  }
}

async function changePassword(req, res, next) {
  metrics.inc('user.password-change')
  const userId = SessionManager.getLoggedInUserId(req.session)

  const { user } = await AuthenticationManager.promises.authenticate(
    { _id: userId },
    req.body.currentPassword,
    null,
    { enforceHIBPCheck: false }
  )
  if (!user) {
    return HttpErrorHandler.badRequest(
      req,
      res,
      req.i18n.translate('password_change_old_password_wrong')
    )
  }

  if (req.body.newPassword1 !== req.body.newPassword2) {
    return HttpErrorHandler.badRequest(
      req,
      res,
      req.i18n.translate('password_change_passwords_do_not_match')
    )
  }

  try {
    await AuthenticationManager.promises.setUserPassword(
      user,
      req.body.newPassword1
    )
  } catch (error) {
    if (error.name === 'InvalidPasswordError') {
      const message = AuthenticationManager.getMessageForInvalidPasswordError(
        error,
        req
      )
      return res.status(400).json({ message })
    } else if (error.name === 'PasswordMustBeDifferentError') {
      return HttpErrorHandler.badRequest(
        req,
        res,
        req.i18n.translate('password_change_password_must_be_different')
      )
    } else if (error.name === 'PasswordReusedError') {
      return res.status(400).json({
        message: {
          key: 'password-must-be-strong',
        },
      })
    } else {
      throw error
    }
  }
  await UserAuditLogHandler.promises.addEntry(
    user._id,
    'update-password',
    user._id,
    req.ip
  )

  // no need to wait, errors are logged and not passed back
  _sendSecurityAlertPasswordChanged(user)

  await UserSessionsManager.promises.removeSessionsFromRedis(
    user,
    req.sessionID // remove all sessions except the current session
  )

  await OneTimeTokenHandler.promises.expireAllTokensForUser(
    userId.toString(),
    'password'
  )

  return res.json({
    message: {
      type: 'success',
      email: user.email,
      text: req.i18n.translate('password_change_successful'),
    },
  })
}

async function clearSessions(req, res, next) {
  metrics.inc('user.clear-sessions')
  const userId = SessionManager.getLoggedInUserId(req.session)
  const user = await UserGetter.promises.getUser(userId, { email: 1 })
  const sessions = await UserSessionsManager.promises.getAllUserSessions(user, [
    req.sessionID,
  ])
  await UserAuditLogHandler.promises.addEntry(
    user._id,
    'clear-sessions',
    user._id,
    req.ip,
    { sessions }
  )
  await UserSessionsManager.promises.removeSessionsFromRedis(
    user,
    req.sessionID // remove all sessions except the current session
  )

  await _sendSecurityAlertClearedSessions(user)

  res.sendStatus(201)
}

async function ensureAffiliation(user) {
  if (!Features.hasFeature('affiliations')) {
    return
  }

  const flaggedEmails = user.emails.filter(email => email.affiliationUnchecked)
  if (flaggedEmails.length === 0) {
    return
  }

  if (flaggedEmails.length > 1) {
    logger.error(
      { userId: user._id },
      `Unexpected number of flagged emails: ${flaggedEmails.length}`
    )
  }

  await _ensureAffiliation(user._id, flaggedEmails[0])
}

async function ensureAffiliationMiddleware(req, res, next) {
  let user
  if (!Features.hasFeature('affiliations') || !req.query.ensureAffiliation) {
    return next()
  }
  const userId = SessionManager.getLoggedInUserId(req.session)
  try {
    user = await UserGetter.promises.getUser(userId)
  } catch (error) {
    return new Errors.UserNotFoundError({ info: { userId } })
  }
  // if the user does not have permission to add an affiliation, we skip this middleware
  try {
    req.assertPermission('add-affiliation')
  } catch (error) {
    if (error instanceof Errors.ForbiddenError) {
      return next()
    }
  }
  try {
    await ensureAffiliation(user)
  } catch (error) {
    return next(error)
  }
  return next()
}

async function tryDeleteUser(req, res, next) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  const { password } = req.body
  req.logger.addFields({ userId })

  if (password == null || password === '') {
    logger.err({ userId }, 'no password supplied for attempt to delete account')
    return res.sendStatus(403)
  }

  const { user } = await AuthenticationManager.promises.authenticate(
    { _id: userId },
    password,
    null,
    { enforceHIBPCheck: false }
  )
  if (!user) {
    logger.err({ userId }, 'auth failed during attempt to delete account')
    return res.sendStatus(403)
  }

  try {
    await UserDeleter.promises.deleteUser(userId, {
      deleterUser: user,
      ipAddress: req.ip,
    })
  } catch (err) {
    const errorData = {
      message: 'error while deleting user account',
      info: { userId },
    }
    if (err instanceof Errors.SubscriptionAdminDeletionError) {
      // set info.public.error for JSON response so frontend can display
      // a specific message
      errorData.info.public = {
        error: 'SubscriptionAdminDeletionError',
      }
      logger.warn(OError.tag(err, errorData.message, errorData.info))
      return HttpErrorHandler.unprocessableEntity(
        req,
        res,
        errorData.message,
        errorData.info.public
      )
    } else {
      throw err
    }
  }

  const sessionId = req.sessionID

  if (typeof req.logout === 'function') {
    const logout = promisify(req.logout)
    await logout()
  }

  const destroySession = promisify(req.session.destroy.bind(req.session))
  await destroySession()

  UserSessionsManager.promises.untrackSession(user, sessionId).catch(err => {
    logger.warn({ err, userId: user._id }, 'failed to untrack session')
  })
  res.sendStatus(200)
}

async function subscribe(req, res, next) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  req.logger.addFields({ userId })

  const user = await UserGetter.promises.getUser(userId, {
    _id: 1,
    email: 1,
    first_name: 1,
    last_name: 1,
  })
  await NewsletterManager.promises.subscribe(user)
  res.json({
    message: req.i18n.translate('thanks_settings_updated'),
  })
}

async function unsubscribe(req, res, next) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  req.logger.addFields({ userId })

  const user = await UserGetter.promises.getUser(userId, {
    _id: 1,
    email: 1,
    first_name: 1,
    last_name: 1,
  })
  await NewsletterManager.promises.unsubscribe(user)
  await Modules.promises.hooks.fire('newsletterUnsubscribed', user)
  res.json({
    message: req.i18n.translate('thanks_settings_updated'),
  })
}

async function updateUserSettings(req, res, next) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  req.logger.addFields({ userId })

  const user = await User.findById(userId).exec()
  if (user == null) {
    throw new OError('problem updating user settings', { userId })
  }

  if (req.body.first_name != null) {
    user.first_name = req.body.first_name.trim()
  }
  if (req.body.last_name != null) {
    user.last_name = req.body.last_name.trim()
  }
  if (req.body.role != null) {
    user.role = req.body.role.trim()
  }
  if (req.body.institution != null) {
    user.institution = req.body.institution.trim()
  }
  if (req.body.mode != null) {
    user.ace.mode = req.body.mode
  }
  if (req.body.editorTheme != null) {
    user.ace.theme = req.body.editorTheme
  }
  if (req.body.overallTheme != null) {
    user.ace.overallTheme = req.body.overallTheme
  }
  if (req.body.fontSize != null) {
    user.ace.fontSize = req.body.fontSize
  }
  if (req.body.autoComplete != null) {
    user.ace.autoComplete = req.body.autoComplete
  }
  if (req.body.autoPairDelimiters != null) {
    user.ace.autoPairDelimiters = req.body.autoPairDelimiters
  }
  if (req.body.spellCheckLanguage != null) {
    user.ace.spellCheckLanguage = req.body.spellCheckLanguage
  }
  if (req.body.pdfViewer != null) {
    user.ace.pdfViewer = req.body.pdfViewer
  }
  if (req.body.syntaxValidation != null) {
    user.ace.syntaxValidation = req.body.syntaxValidation
  }
  if (req.body.fontFamily != null) {
    user.ace.fontFamily = req.body.fontFamily
  }
  if (req.body.lineHeight != null) {
    user.ace.lineHeight = req.body.lineHeight
  }
  await user.save()

  const newEmail = req.body.email?.trim().toLowerCase()
  if (
    newEmail == null ||
    newEmail === user.email ||
    req.externalAuthenticationSystemUsed()
  ) {
    // end here, don't update email
    SessionManager.setInSessionUser(req.session, {
      first_name: user.first_name,
      last_name: user.last_name,
    })
    res.sendStatus(200)
  } else if (newEmail.indexOf('@') === -1) {
    // email invalid
    res.sendStatus(400)
  } else {
    // update the user email
    const auditLog = {
      initiatorId: userId,
      ipAddress: req.ip,
    }

    try {
      await UserUpdater.promises.changeEmailAddress(userId, newEmail, auditLog)
    } catch (err) {
      if (err instanceof Errors.EmailExistsError) {
        const translation = req.i18n.translate('email_already_registered')
        return HttpErrorHandler.conflict(req, res, translation)
      } else {
        return HttpErrorHandler.legacyInternal(
          req,
          res,
          req.i18n.translate('problem_changing_email_address'),
          OError.tag(err, 'problem_changing_email_address', {
            userId,
            newEmail,
          })
        )
      }
    }

    const user = await User.findById(userId).exec()
    SessionManager.setInSessionUser(req.session, {
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
    })

    try {
      await UserHandler.promises.populateTeamInvites(user)
    } catch (err) {
      logger.error({ err }, 'error populateTeamInvites')
    }

    res.sendStatus(200)
  }
}

async function doLogout(req) {
  metrics.inc('user.logout')
  const user = SessionManager.getSessionUser(req.session)
  logger.debug({ user }, 'logging out')
  const sessionId = req.sessionID

  if (typeof req.logout === 'function') {
    // passport logout
    const logout = promisify(req.logout.bind(req))
    await logout()
  }

  const destroySession = promisify(req.session.destroy.bind(req.session))
  await destroySession()

  if (user != null) {
    UserSessionsManager.promises.untrackSession(user, sessionId).catch(err => {
      logger.warn({ err, userId: user._id }, 'failed to untrack session')
    })
  }
}

async function logout(req, res, next) {
  const requestedRedirect = req.body.redirect
    ? UrlHelper.getSafeRedirectPath(req.body.redirect)
    : undefined
  const redirectUrl = requestedRedirect || '/login'

  await doLogout(req)

  if (acceptsJson(req)) {
    res.status(200).json({ redir: redirectUrl })
  } else {
    res.redirect(redirectUrl)
  }
}

// >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
async function logoutOauth(req, res, next) {
  redirectUrl = process.env.OAUTH2_LOGOUT_URL

  await doLogout(req)

  if (acceptsJson(req)) {
    res.status(200).json({ redir: redirectUrl })
  } else {
    res.redirect(redirectUrl)
  }
}
// <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<

async function expireDeletedUser(req, res, next) {
  const userId = req.params.userId
  await UserDeleter.promises.expireDeletedUser(userId)
  res.sendStatus(204)
}

async function expireDeletedUsersAfterDuration(req, res, next) {
  await UserDeleter.promises.expireDeletedUsersAfterDuration()
  res.sendStatus(204)
}

module.exports = {
  clearSessions: expressify(clearSessions),
  changePassword: expressify(changePassword),
  tryDeleteUser: expressify(tryDeleteUser),
  subscribe: expressify(subscribe),
  unsubscribe: expressify(unsubscribe),
  updateUserSettings: expressify(updateUserSettings),
  doLogout: callbackify(doLogout),
  logout: expressify(logout),
  expireDeletedUser: expressify(expireDeletedUser),
  expireDeletedUsersAfterDuration: expressify(expireDeletedUsersAfterDuration),
  promises: {
    doLogout,
    ensureAffiliation,
    ensureAffiliationMiddleware,
  },
}
