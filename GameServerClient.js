//event constants
const READY_EVENT = "ready";
const OPEN_EVENT = "open";
const CLOSE_EVENT = "close";
const SEND_EVENT = "send";
const ERROR_EVENT = "event";
const MESSAGE_EVENT = "message";
const SIGN_OUT_EVENT = "sign_out"

//message type constants
const ERROR_TYPE = "error";
const REQUEST_TYPE = "request";
const RESPONSE_TYPE = "response";
const AUTH_TYPE = "authenticate"

//action constants
const LOGIN_ACTION = "login";
const LOGIN_GUEST_ACTION = "login_guest";
const REGISTER_ACTION = "register";
const SIGN_OUT_ACTION = "sign_out";
const VALUE_ACTION = "value";
const SESSION_AUTH_ACTION = "session_auth";
const ENTER_GAME_ACTION = "enter_game";
const CREATE_GAME_ACTION = "create_game";

//cookie constant
const GS_SESS_ID = "GS_SESS_ID";


//A WebSocket that interfaces with a Java GameServer
class GameServerSocket extends EventTarget{

  //Constructor
  constructor(propertiesLocation){
    //Call superconstructor
    super();
    //websocket
    this.socket = null;
    //server configuration
    this.properties = null;
    //connection url
    this.url = null;
    //all messages that havent received an answer yet
    this.pendingMessages = new Map();
    //if socket is ready to connect
    this.ready = false;

    //load properties from config file and then dispatch READY event
    var self = this;
    this.loadProperties(propertiesLocation).then(() =>{
      //send ready event
      self.ready = true;
      var event = new Event(READY_EVENT);
      self.dispatchEvent(event);
    });
  }

  //Builds a URL from the properties
  buildURL(){
    return this.properties.get("server.protocol") + "://" + this.properties.get("server.address") + ":" + this.properties.get("server.port");
  }

  //connect the websocket
  open(url = this.buildURL()){ //build URL from config if none is specified
    this.socket = new WebSocket(url);
    this.url = this.socket.url;

    //reference to this instance for different namespace
    var self = this;

    //set socket onOpen to trigger an event
    //check for GS_SESS_ID cookie
    //if it exists, try to authenticate connection with GS_SESS_ID
    this.socket.onopen = function(e){
      //check for GS_SESS_ID cookie
      var sessionID = getCookie(GS_SESS_ID);
      if(sessionID != ""){
        console.log("SESSION ID: " + sessionID);
        //authenticate using the sessionID
        var data = self.buildMessage(AUTH_TYPE, SESSION_AUTH_ACTION);
        data.session_id = sessionID;
        self.sendJSON(data);

        //only trigger open event after SESSION_AUTH_ACTION has been resolved
        self.responseListener(data)
        .catch(error => {
          //trigger error message, if server sends an error
          GSError(error);
        })
        .finally(() => {
          //send open event
          var event = new Event(OPEN_EVENT);
          event.data = e;
          self.dispatchEvent(event);
        });


      } else {
        //send open event
        var event = new Event(OPEN_EVENT);
        event.data = e;
        self.dispatchEvent(event);
      }
    }

    //set socket onMessage to parse data and trigger an event
    //also removes message from pending
    this.socket.onmessage = function(e){
      //parse data
      var data = JSON.parse(e.data);
      //remove message from list of pending
      self.pendingMessages.delete(data.message_id);

      //events to be triggered
      var events = [];

      //create message specific event
      events.push(new Event(data.message_id));

      if(data.type == ERROR_TYPE){
        //if message was an error, trigger an error event
        events.push(new Event(ERROR_EVENT));
      } else {
        //else trigger message event
        events.push(new Event(MESSAGE_EVENT));
      }

      //set data and trigger events
      for(let e of events){
        e.data = data;
        self.dispatchEvent(e);
      }
    }

    //set socket onClose to trigger an event
    this.socket.onclose = function(e){
      var event = new Event(CLOSE_EVENT);
      event.data = e;
      self.dispatchEvent(event);
    }

  };

  //stringify object and send it to the server
  sendJSON(data) {
    if(this.isOpen()){
      //add message to pending and send it
      this.pendingMessages.set(data.message_id, data);
      this.socket.send(JSON.stringify(data));
      //dispatch SEND event
      var event = new Event(SEND_EVENT);
      event.data = data;
      this.dispatchEvent(event);

      //return response listener
      //the response listener will also remove the message form pending
      //if it times out
      return this.responseListener(data);
    } else {
      //if not connected, error
      var error = data;
      data.type = ERROR_TYPE;
      data.error_message = "Not Connected to server";
      GSError(error);
    }
  }

  //closes the connection
  close(code = 1000, reason = ""){
    this.socket.close(code, reason);
  }

  //load properties of the config file
  //returns a promise that resolves after the properties loaded
  loadProperties(location){
    //Fetch config file
    var self = this;
    return fetch(location)
    .then(response => response.text())
    .then(text => {
      //parse properties and save them
      self.properties = parseProperties(text);
    });
  }

  //generates a unique messageID
  generateMessageID(){
    //alphabet for the ID
    var alphabet = "abcdefghijklmnopqrstuvwxyz";
    alphabet += "1234567890";

    //amount of tries before giving up
    var maxTries = 100;
    var curTry = 0;
    do {

      //generate 8 character long id
      var id = "";
      for(var i = 0; i < 8; i++){
        var index  = Math.floor(Math.random() * 10000) % alphabet.length;
        id += alphabet.charAt(index);
      }
      //test if id is unique, if so return it
      if(!this.pendingMessages.has(id)){
        return id;
      }
      //if id wasn't unique, increment try counter and try again
      curTry++;
    } while (curTry <= maxTries);
    return null;
  }

  //builds a message template
  buildMessage(type, action){
    return {
      message_id: this.generateMessageID(),
      type: type,
      action: action
    }
  }

  //tries to enter a specified game
  enterGame(gameID){
    var data = this.buildMessage(REQUEST_TYPE, ENTER_GAME_ACTION);
    data.game_id = gameID;
    return this.sendJSON(data);
  }

  //creates a new game
  createGame(){
    var data = this.buildMessage(REQUEST_TYPE, CREATE_GAME_ACTION);
    return this.sendJSON(data);
  }

  //tries to register the user
  register(username, password){
    return this.authenticate(username, password, REGISTER_ACTION);
  }

  //tries to log in the user
  login(username, password){
    return this.authenticate(username, password, LOGIN_ACTION);
  }

  //logs in as a guest
  loginGuest(username){
    return this.authenticate(username, "", LOGIN_GUEST_ACTION);
  }

  //tries to authenticate the user
  authenticate(username, password, type){
    var data = this.buildMessage(AUTH_TYPE, type);
    data.username = username;
    data.password = password;

    //set a responseListener to listen for the Session ID
    this.responseListener(data).then(data => {
      setCookie(GS_SESS_ID, data.session_id);
    })
    .catch(error => {
      //do nothing
    });

    //return the response listener
    return this.sendJSON(data);
  }

  //requests a value from the server, and returns a promise with the response
  getValue(value){
    //send request to the server
    var data = this.buildMessage(REQUEST_TYPE, VALUE_ACTION);
    data.value = value;

    //return a responseListener (Promise)
    return this.sendJSON(data);
  }

  //signs out
  signOut(){
    var self = this;
    var data = this.buildMessage(REQUEST_TYPE, SIGN_OUT_ACTION);
    this.sendJSON(data).finally(() => {
      //dispatch SIGN_OUT event
      var event = new EVENT(SIGN_OUT_EVENT);
      self.dispatchEvent(event);
    });
  }

  //check if conenction is open
  isOpen(){
    return this.socket.readyState == 1;
  }

  //build a promise that reolves when a reponse to the given message
  //is received
  responseListener(message){
    var self = this;
    return new Promise(
      function (resolve, reject) {
        //function that gets executed when the response is received
        var eventFunction = function (e) {
          //remove the eventlistener
          self.removeEventListener(message.message_id, eventFunction);
          //get response data
          var data = e.data;
          if(data.type == ERROR_TYPE){
            //if response is an error, reject the promise
            reject(data);
          } else{
            //otherwise resolve promise with response data
            resolve(data);
          }
        }

        //reject if connection is closed
        if(!self.isOpen()){
          reject("Not Connected");
        }

        //set timeout to remove event listener in case no reponse comes
        setTimeout(function () {
          //also remove message form pending
          self.pendingMessages.delete(message.message_id);
          self.removeEventListener(message.message_id, eventFunction);
          reject("Message time out: " + message.message_id);
        }, 5000)

        //listen from specific onmessage event
        self.addEventListener(message.message_id, eventFunction);
      }
    );
  }
}

//parses a GameServerSocket config file
function parseProperties(text){
  var props = new Map();
  text = text.split("\n");
  for(var line of text){
    line = line.replaceAll(/\s/g,'');
    if(line.charAt(0) == "#" || line.charAt(0) == "!" || line == "")continue;
    var prop = line.split("=", 2);
    props.set(prop[0], prop[1]);
  }
  return props;
}

//returns a cookie with a given name
function getCookie(cname) {
  var name = cname + "=";
  var decodedCookie = decodeURIComponent(document.cookie);
  var ca = decodedCookie.split(';');
  for(var i = 0; i <ca.length; i++) {
    var c = ca[i];
    while (c.charAt(0) == ' ') {
      c = c.substring(1);
    }
    if (c.indexOf(name) == 0) {
      return c.substring(name.length, c.length);
    }
  }
  return "";
}

//sets a cookie
function setCookie(cname, cvalue) {
  document.cookie = cname + "=" + cvalue + ";path=/";
}

//GameServer Error handler
function GSError(error) {
  console.error("GameServer Error:", error);
}
