/**
 * NodeRED Google SmartHome
 * Copyright (C) 2021 Michael Jacobsen.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

'use strict';

const path           = require('path');
const fs             = require('fs');
const TokenGenerator = require('uuid-token-generator');
const util           = require('util');

/******************************************************************************************************************
 * Auth
 *
 */
class Auth {
    constructor() {
        this._clientId       = "";
        this._clientSecret   = "";
        this._username       = "";
        this._password       = "";
        this._useGoogleClientAuth = false;
        this._googleClientId = "";
        this._emails         = [];
        this._authCode       = new Map();
        this._auth           = null;
        this._authFilename   = null;
        this._jwtkey         = null;
        this._accessTokenDuration = 60;
        this._tokenGen       = new TokenGenerator(256, TokenGenerator.BASE58);
        this._clearAllTokens();
    }
    //
    //
    //
    loadAuth(nodeId, userDir, username) {
        const me = this;

        try {
            me._authFilename = userDir + '/google-smarthome-auth-' + nodeId + '.json';

            let authFile = fs.readFileSync(
                me._authFilename,
                {
                    'encoding': 'utf8',
                    'flag': fs.constants.R_OK | fs.constants.W_OK | fs.constants.O_CREAT
                });

            if (authFile === '') {
                me.debug('Auth:loadAuth(): data not persisted, create new');
                me._clearAllTokens();
            } else {
                me.debug('Auth:loadAuth(): data already persisted');
                me._auth = JSON.parse(authFile);
                if (typeof me._auth !== 'object' || Array.isArray(me._auth)) {
                    me._clearAllTokens();
                }
                if (!me._auth.localAuthCode) {
                    me.generateLocalAccessToken();
                }
                if (!me._auth.nextLocalAuthCode) {
                    me._auth.nextLocalAuthCode = this._generateNewAccessToken();
                }
                me.debug('Auth:loadAuth(): me._auth = ' + JSON.stringify(me._auth));
            }
            me._persistAuth();
        }
        catch (err) {
            me.error('Error on loading auth storage: ' + err.toString());
            me._clearAllTokens();
            process.nextTick(() => {
                me.emitter.emit('auth', 'error', err);
            });
        }
    }
    //
    //
    //
    setJwtKey(jwtkey, userDir) {
        if (!jwtkey.startsWith(path.sep)) {
            jwtkey = path.join(userDir, jwtkey);
        }
        let jk       = fs.readFileSync(jwtkey);
        this._jwtkey = JSON.parse(jk.toString());
    }
    //
    //
    //
    setClientIdSecret(clientid, clientsecret) {
        this._clientId     = clientid;
        this._clientSecret = clientsecret;
    }
    //
    //
    //
    setUsernamePassword(username, password) {
        this._useGoogleClientAuth = false;
        this._username = username;
        this._password = password;
    }
    //
    //
    //
    setGoogleClientIdAndEmails(clientid, emails) {
        this._useGoogleClientAuth = true;
        this._googleClientId = clientid;
        if (typeof emails === "string") {
            this._emails = emails.split(";");
        } else {
            this._emails = emails;
        }
    }
    //
    //
    //
    useGoogleClientAuth() {
        return this._useGoogleClientAuth;
    }
    //
    //
    //
    getGoogleClientId() {
        return this._googleClientId;
    }
    //
    //
    //
    getGoogleClientEmails() {
        return this._emails;
    }
    //
    //
    //
    isGoogleClientEmailValid(email) {
        if (this._useGoogleClientAuth) {
            return this._emails.includes(email);
        }
        return false;
    }
    //
    //
    //
    setAccessTokenDuration(duration) {
        this._accessTokenDuration = duration;
    }
    //
    //
    //
    getAccessTokenDuration() {
        return this._accessTokenDuration;
    }
    //
    //
    //
    isValidUser(username, password) {
        if (this._username !== username) {
            this.debug('Auth:isValidUser(): username does not match!');
            return false;
        }

        if (this._password !== password) {
            this.debug('Auth:isValidUser(): password does not match!');
            return false;
        }

        return true;
    }
    //
    //
    //
    getLocalAuthCode() {
        return this._auth.nextLocalAuthCode;
    }
    //
    //
    //
    generateAuthCode(username) {
        this.removeExpiredAuthCode();

        while (true) {
            let authCode = this.genRandomString();
            const authCodeInfo = this._authCode.get(authCode);
            if (typeof authCodeInfo === 'undefined') {
                this._authCode.set(authCode, {
                    user: username,
                    expiresAt: new Date(Date.now() + (10 * 60000)), // 10 minutes
                });

                return authCode;
            }
        }
    }
    //
    //
    //
    removeExpiredAuthCode() {
        const now = Date.now();
        let toDel = [];
        for (let authCode of this._authCode.keys()) {
            const authCodeInfo = this._authCode.get(authCode);
            const expirationDate = new Date(authCodeInfo.expiresAt);
            if (expirationDate < now) {
                toDel.push(authCode);
            }
        }
        for (let authCode of toDel) {
            this._authCode.delete(authCode);
        }
    }
    //
    //
    //
    isUserLoggedIn() {
        // this._removeAllAccessTokensExpiredAndForUser();
        // return Object.keys(this._auth.accessTokens).length > 0;
        return Object.keys(this._auth.refreshTokens).length > 0;
    }
    //
    //
    //
    isValidClient(clientId, clientSecret) {
        if (this._clientId !== clientId) {
            this._mgmtNode.error(util.format('Auth:isValidClient(): clientId does not match (expected "%s", got "%s")!', this._clientId, clientId));
            return false;
        }

        if (arguments.length == 2 && this._clientSecret !== clientSecret) {
            this._mgmtNode.error(util.format('Auth:isValidClient(): clientSecret does not match (expected "%s", got "%s")!', this._clientSecret, clientSecret));
            return false;
        }

        return true;
    }

    /**
     * Check if the URI given as redirect_uri is a valid URI for redirecting back to Google after a successful login.
     *
     * Valid URIs are:
     * - https://oauth-redirect.googleusercontent.com/r/YOUR_PROJECT_ID
     * - https://oauth-redirect-sandbox.googleusercontent.com/r/YOUR_PROJECT_ID
     *
     * To check via the check page, our own domain (specified by my_uri, e.g. https://example.com:3001) is also allowed.
     *
     * @param redirect_uri URI to check
     * @param my_uri
     * @returns {boolean} true if the URI is valid, false otherwise
     */
    isValidRedirectUri(redirect_uri, my_uri) {
        if (my_uri) {
            // Remove port from URI to allow different ports (due to port forwarding or proxying)
            let my_uri_without_port = my_uri.replace(/:\d+/, '');
            let redirect_uri_without_port = redirect_uri.replace(/:\d+/, '');
            if(redirect_uri_without_port.startsWith(my_uri_without_port)) {
                return true;
            }
        }

        let project_id = this.getProjectId();
        if ('https://oauth-redirect.googleusercontent.com/r/' + project_id !== redirect_uri &&
            'https://oauth-redirect-sandbox.googleusercontent.com/r/' + project_id !== redirect_uri) {
            this._mgmtNode.error('Auth:isValidRedirectUri(): invalid redirect uri!');
            return false;
        }

        return true;
    }
    //
    //
    //
    exchangeAuthCode(authCode, redirect_uri, my_uri) {
        let me = this;
        let authCodeInfo = this._authCode.get(authCode);

        if (typeof authCodeInfo === 'undefined') {
            throw 'invalid authCode ' + authCode;
        }

        const expirationDate = new Date(authCodeInfo.expiresAt);
        const user = authCodeInfo.user;
        if (expirationDate < Date.now()) {
            throw 'expired authCode; user = ' + user + 'expired at ' + expirationDate.toLocaleString() + ' authCode = ' + authCode;
        }

        this.debug('Auth:exchangeAuthCode(): user = ' + user);

        if (!this.isValidRedirectUri(redirect_uri, my_uri)) {
            throw 'redirect_uri ' + redirect_uri + ' invalid';
        }

        this._authCode.delete(authCode);

        me._removeAllTokensForUser(user);

        let refreshToken = me._generateRefreshToken(user);
        let accessToken = me._generateAccessToken(user);

        me._persistAuth();

        return {
            token_type: 'bearer',
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_in: 60 * this._accessTokenDuration,
        };
    }
    //
    //
    //
    refreshAccessToken(refreshToken) {
        let me = this;
        if (!this.isValidRefreshToken(refreshToken)) {
            throw 'invalid refresh token ' + refreshToken;
        }

        const user = this._auth.refreshTokens[refreshToken];
        me._removeAllAccessTokensExpiredAndForUser(user);

        let accessToken = me._generateAccessToken(user);

        me._persistAuth();

        return {
            token_type: 'bearer',
            access_token: accessToken,
            expires_in: 60 * this._accessTokenDuration,
        };
    }
    //
    //
    //
    isValidAccessToken(accessToken) {
        return this.getuserForAccessToken(accessToken) !== null;
    }
    //
    //
    //
    isValidLocalAccessToken(accessToken) {
        if (accessToken === this._auth.nextLocalAuthCode) {
            this._auth.localAuthCode = this._auth.nextLocalAuthCode;
            this._auth.nextLocalAuthCode = this._generateNewAccessToken();
            this._persistAuth();
            return true;
        }
        return accessToken === this._auth.localAuthCode;
    }
    //
    //
    //
    getuserForAccessToken(accessToken) {
        if (accessToken === this._auth.localAuthCode || accessToken === this._auth.nextLocalAuthCode) {
            return "local execution";
        }
        const accessTokenInfo = this._auth.accessTokens[accessToken];
        if (typeof accessTokenInfo === 'undefined') {
            this.debug('Auth:isValidAccessToken(): accessToken = ' + JSON.stringify(accessToken) + ' not found.');
            return null;
        }
        const user = accessTokenInfo.user;
        const expiresAt = new Date(accessTokenInfo.expiresAt);
        if (expiresAt < new Date()) {
            this.debug('Auth:isValidAccessToken(): accessToken = ' + JSON.stringify(accessToken));
            this.debug('Auth:isValidAccessToken(): user = ' + user);
            this.debug('Auth:isValidAccessToken(): expiresAt = ' + expiresAt.toLocaleString());
            this.debug('Auth:isValidAccessToken(): accessToken expired');
            return null;
        }
        return user;
    }
    //
    //
    //
    isValidRefreshToken(refreshToken) {
        const refreshTokenInfo = this._auth.refreshTokens[refreshToken];
        if (typeof refreshTokenInfo === 'undefined') {
            this._mgmtNode.error('Auth:isValidRefreshToken(): refreshToken not found ' + JSON.stringify(refreshToken));
            return false;
        }
        this.debug('Auth:isValidRefreshToken(): valid refreshToken ' + JSON.stringify(refreshToken) + " for user " + refreshTokenInfo);
        return true;
    }
    //
    //
    //
    removeAllTokensForUser(user) {
        this._removeAllTokensForUser(user);
        this._persistAuth();
    }
    //
    //
    //
    getJwtClientEmail() {
        return this._jwtkey.client_email;
    }
    //
    //
    //
    getJwtPrivateKey() {
        return this._jwtkey.private_key;
    }
    //
    //
    //
    getProjectId() {
        return this._jwtkey.project_id;
    }
    //
    //
    //
    genRandomString() {
        return this._tokenGen.generate();
    }
    //
    //
    //
    getAuth() {
        return this._auth;
    }
    //
    //
    //
    generateLocalAccessToken() {
        this._auth.localAuthCode = this._generateNewAccessToken();
        if (!this._auth.nextLocalAuthCode) {
            this._auth.nextLocalAuthCode = this._generateNewAccessToken();
        }
        return this._auth.localAuthCode;
    }
    /******************************************************************************************************************
     * private methods
     *
     */
     _generateNewAccessToken() {
        while (true) {
            let accessToken = this.genRandomString();
            if (accessToken !== this._auth.localAuthCode && accessToken !== this._auth.nextLocalAuthCode && typeof this._auth.accessTokens[accessToken] == 'undefined') {
                return accessToken;
            }
        }
    }
    _generateAccessToken(user) {
        let accessToken = this._generateNewAccessToken();
        this._auth.accessTokens[accessToken] = {
            user: user,
            expiresAt: Date.now() + (this._accessTokenDuration * 60000),
        };
        return accessToken;
    }
    //
    _generateRefreshToken(user) {
        while (true) {
            let refreshToken = this.genRandomString();
            if (typeof this._auth.refreshTokens[refreshToken] == 'undefined') {
                this._auth.refreshTokens[refreshToken] = user;
                return refreshToken;
            }
        }
    }
    //
    _removeAllAccessTokensExpiredAndForUser(user) {
        let toDel = [];
        for (let token in this._auth.accessTokens) {
            let tokenInfo = this._auth.accessTokens[token];
            let expiresAt = tokenInfo.expiresAt;
            let tokenUser = tokenInfo.user;
            if ((tokenUser == user) || (new Date(expiresAt) < new Date())) {
                toDel.push(token);
            }
        }
        for (let token of toDel) {
            delete this._auth.accessTokens[token];
        }
    }
    //
    _removeAllTokensForUser(user) {
        this._removeAllAccessTokensExpiredAndForUser(user);
        let toDel = [];
        for (let token in this._auth.refreshTokens) {
            let tokenUser = this._auth.refreshTokens[token];
            if (tokenUser == user) {
                toDel.push(token);
            }
        }
        for (let token of toDel) {
            delete this._auth.refreshTokens[token];
        }
    }
    //
    _persistAuth() {
        try {
            fs.writeFileSync(this._authFilename, JSON.stringify(this._auth))
        }
        catch (err) {
            this._mgmtNode.error('Auth:_persistAuth(): Failed to write auth file: ' + err);
        }
    }
    //
    _clearAllTokens() {
        this._auth = { 
            "accessTokens" : {},
            "refreshTokens" : {},
            "localAuthCode": '',
            "nextLocalAuthCode": ''
        };
        this.generateLocalAccessToken();
    }
}

module.exports = Auth;
