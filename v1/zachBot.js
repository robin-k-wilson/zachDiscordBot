//
// zachBot.js
//
// Created by Zach Fox on 2018-10-13
//
// Distributed under the MIT License.
// See the accompanying LICENSE.txt file for details.
//

// Includes
const { Client } = require('discord.js');
const auth = require('./auth.json');
const https = require('https');
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const ytdl = require('ytdl-core');
const {google} = require('googleapis');
const {googleAuth} = require('google-auth-library');
const prism = require('prism-media');
const imageMagick = require('imagemagick');
const ColorScheme = require('color-scheme');

const SQLite = require("better-sqlite3");
const quotesSQL = new SQLite('./quotes/quotes.sqlite');
const quoteIntervalsSQL = new SQLite('./quotes/quoteIntervals.sqlite');
const soundsSQL = new SQLite('./sounds/sounds.sqlite');
const playlistsSQL = new SQLite('./playlists/playlists.sqlite');

// Initialize discord.js Discord Bot
var bot = new Client();

// Log in with the `discordToken` auth token stored in `auth.json`
bot.login(auth.discordToken);
const youtubeAuthToken = auth.youtubeToken || false;

// Don't handle any commands until `isReady` is set to true
var isReady = false;
// Used to determine the voice channel in which the bot is located
var currentVoiceChannel = false;
// Used when connected to a voice channel
var currentVoiceConnection = false;
// Used when playing media
var currentStreamDispatcher = false;
// Used when playing YouTube video
var youtubeVolume = 0.3;
// Populated by the contents of the `bigEmoji` folder
var availableEmojis = {};
// Populated by the contents of the `sounds` folder
// Organized like:
// `sounds/<name of person who said sound>/<soundID>.mp3`
var soundboardData = { "data": {} };
// Used for sending status messages
var statusChannel;
// Sent to the channel when a user enters an invalid command.
// key is command, value is error message.
// The keys in this object are used to enumerate the valid commands
// when the user issues the help command.
var errorMessages = {
    "e": "", // Will be filled in once emoji system is ready
    "sb": 'invalid arguments. usage: !sb <sound ID> <(optional) person>',
    "sbv": 'invalid arguments. usage: !sbv <sound ID> <(optional) person>',
    "leave": "...i'm not in a voice channel",
    "quote": "add the '🔠' emoji to some text to get started.\nsay !quote to get a random quote.\nuse !quote delete <id> to delete a quote.\nuse !quote interval <time in seconds> to have the bot dispense a quote every <seconds> seconds.",
    "soundStats": "invalid arguments. usage: !soundStats <*|(optional) sound ID> <(optional) person>",
    "y": "invalid arguments. usage: !y <search query|link to youtube video>",
    "yp": "invalid arguments. usage: !yp <list|next|back|clear|del|repeat> <(when del is the command) index | (when repeat is the command) none|one|all | (when list is the command) (optional) save|load|import> <(when list is the command) playlist name | (when list is the command) playlist URL> <(when importing a playlist from URL) playlist name>",
    "v": "invalid arguments. usage: !v <pause|resume|vol> <(optional) volume value>",
    "roleColor": "invalid arguments. usage: !roleColor #<hex representation of a color, no alpha>"
}

    
// Set to true when we've recorded all available emoji
var emojiSystemReady = false;
// Set to true when we've recorded all available soundboard sounds
var soundboardSystemReady = false;
// Call this after setting one of the subsystem's ready status to true
var firstReadyUpdateComplete = false;
var updateReadyStatus = function() {
    // We're ready for commands if all subsystems are ready!
    isReady = emojiSystemReady && soundboardSystemReady;
    if (isReady) {
        if (!firstReadyUpdateComplete) {
            console.log('Bot ready.');
            statusChannel.send("Bot ready.");
        }
        firstReadyUpdateComplete = true;
    }
}

    
// For every file in the `./bigEmoji` directory,
// add that filename (minus extension) to our list
// of available emoji.
function refreshEmoji() {
    console.log('Refreshing emoji system...');
    emojiSystemReady = false;
    availableEmojis = {};
    var emojiFiles = fs.readdirSync("./bigEmoji");
    for (var i = 0; i < emojiFiles.length; i++) {
        if (emojiFiles[i] === "README.md") {
            continue;
        }
        availableEmojis[emojiFiles[i].slice(0, -4)] = emojiFiles[i];
    }
    emojiSystemReady = true;
    errorMessages["e"] = ('invalid emoji. usage: !e <emoji name>.\navailable emojis:\n' + (Object.keys(availableEmojis).join(", ")));
    updateReadyStatus();
    console.log('Emoji system ready.');
}


function startAllQuoteIntervals() {
    var allChannels = bot.channels;

    allChannels.tap(function(value, key, map) {
        var result = bot.getQuoteIntervalsForChannel.all(key);
        if (result && result.length > 0) {
            for (var i = 0; i < result.length; i++) {
                console.log(`Starting quote interval from database with ID ${result[i].id}`);
                startQuoteInterval(result[i].userWhoAdded, result[i].guild, result[i].channel, result[i].intervalS, false);
            }
        }
    });
}


function getDominantColor(imagePath, callback) {
    if (!callback) {
        callback = function () { }
    }

    var imArgs = [imagePath, '-scale', '1x1\!', '-format', '%[pixel:u]', 'info:-']

    imageMagick.convert(imArgs, function (err, stdout) {
        if (err) {
            callback(err);
            return;
        }

        var rgba = stdout.slice(stdout.indexOf('(') + 1, stdout.indexOf(')')).split(',');
        var hex = require('rgb-hex')(stdout);
        callback(null, {"rgba": rgba, "hex": hex});
    });
}

function deleteTempFiles() {
    var directory = __dirname + '/temp';
    var files = fs.readdirSync(directory);

    for (const file of files) {
        if (file === "README.md" || file.indexOf(".mp3") > -1) {
            continue;
        }

        fs.unlinkSync(path.join(directory, file));
    }
}


// Do something when the bot says it's ready
bot.on('ready', function (evt) {
    // Set up the channel where we'll send status messages
    statusChannel = bot.channels.find(ch => ch.name === 'bot-test-zone');
    
    // Log that we're online
    console.log('Bot online.');

    var REFRESH_EMOJI_INTERVAL_MS = 3600000;
    var refreshEmojiInterval = setInterval(refreshEmoji, REFRESH_EMOJI_INTERVAL_MS);
    refreshEmoji();
    
    // Check if the table "quotes" exists.
    const quotesTable = quotesSQL.prepare("SELECT count(*) FROM sqlite_master WHERE type='table' AND name = 'quotes';").get();
    if (!quotesTable['count(*)']) {
        // If the table isn't there, create it and setup the database correctly.
        quotesSQL.prepare("CREATE TABLE quotes (id INTEGER PRIMARY KEY, created DATETIME DEFAULT CURRENT_TIMESTAMP, userWhoAdded TEXT, guild TEXT, channel TEXT, quote TEXT);").run();
        // Ensure that the "id" row is always unique and indexed.
        quotesSQL.prepare("CREATE UNIQUE INDEX idx_quotes_id ON quotes (id);").run();
        quotesSQL.pragma("synchronous = 1");
        quotesSQL.pragma("journal_mode = wal");
    }

    // We have some prepared statements to get, set, and delete the quote data.
    bot.getQuote = quotesSQL.prepare("SELECT * FROM quotes WHERE guild = ? AND channel = ? AND id = ?;");
    bot.getRandomQuote = quotesSQL.prepare("SELECT * FROM quotes WHERE guild = ? AND channel = ? ORDER BY random() LIMIT 1;");
    bot.setQuote = quotesSQL.prepare("INSERT OR REPLACE INTO quotes (userWhoAdded, guild, channel, quote) VALUES (@userWhoAdded, @guild, @channel, @quote);");
    bot.deleteQuote = quotesSQL.prepare("DELETE FROM quotes WHERE guild = ? AND channel = ? AND id = ?;");
    
    // Check if the table "quoteIntervals" exists.
    const quoteIntervalsTable = quoteIntervalsSQL.prepare("SELECT count(*) FROM sqlite_master WHERE type='table' AND name = 'quoteIntervals';").get();
    if (!quoteIntervalsTable['count(*)']) {
        // If the table isn't there, create it and setup the database correctly.
        quoteIntervalsSQL.prepare("CREATE TABLE quoteIntervals (id INTEGER PRIMARY KEY, created DATETIME DEFAULT CURRENT_TIMESTAMP, userWhoAdded TEXT, guild TEXT, channel TEXT, intervalS INTEGER);").run();
        // Ensure that the "id" row is always unique and indexed.
        quoteIntervalsSQL.prepare("CREATE UNIQUE INDEX idx_quoteIntervals_id ON quoteIntervals (id);").run();
        quoteIntervalsSQL.pragma("synchronous = 1");
        quoteIntervalsSQL.pragma("journal_mode = wal");
    }

    // We have some prepared statements to get, set, and delete the quoteIntervals data.
    bot.getQuoteIntervalsForChannel = quoteIntervalsSQL.prepare("SELECT * FROM quoteIntervals WHERE channel = ?;");
    bot.setQuoteInterval = quoteIntervalsSQL.prepare("INSERT INTO quoteIntervals (userWhoAdded, guild, channel, intervalS) VALUES (@userWhoAdded, @guild, @channel, @intervalS);");
    bot.deleteQuoteInterval = quoteIntervalsSQL.prepare("DELETE FROM quoteIntervals WHERE guild = ? AND channel = ? AND id = ?;");

    startAllQuoteIntervals();
    
    // Check if the table "sounds" exists.
    const soundsTable = soundsSQL.prepare("SELECT count(*) FROM sqlite_master WHERE type='table' AND name = 'sounds';").get();
    if (!soundsTable['count(*)']) {
        // If the table isn't there, create it and setup the database correctly.
        soundsSQL.prepare("CREATE TABLE sounds (id INTEGER PRIMARY KEY, created DATETIME DEFAULT CURRENT_TIMESTAMP, soundAuthor TEXT, soundName TEXT, sbRequested INTEGER DEFAULT 0, sbvRequested INTEGER DEFAULT 0, UNIQUE(soundAuthor, soundName));").run();
        // Ensure that the "id" row is always unique and indexed.
        soundsSQL.prepare("CREATE UNIQUE INDEX idx_sounds_id ON sounds (id);").run();
        soundsSQL.pragma("synchronous = 1");
        soundsSQL.pragma("journal_mode = wal");
    }

    // We have some prepared statements to get and set sounds usage data.
    bot.incrementSBUsageData = soundsSQL.prepare("UPDATE sounds SET sbRequested = sbRequested + 1 WHERE soundAuthor = @soundAuthor AND soundName = @soundName;");
    bot.incrementSBVUsageData = soundsSQL.prepare("UPDATE sounds SET sbvRequested = sbvRequested + 1 WHERE soundAuthor = @soundAuthor AND soundName = @soundName;");
    bot.getSpecificSoundUsageData = soundsSQL.prepare("SELECT * FROM sounds WHERE soundName = ?;");
    bot.getSpecificSoundUsageDataByAuthor = soundsSQL.prepare("SELECT *, sbRequested + sbvRequested AS totalRequests FROM sounds WHERE soundAuthor = ? ORDER BY totalRequests DESC LIMIT 50;");
    bot.getSpecificSoundUsageDataWithAuthor = soundsSQL.prepare("SELECT * FROM sounds WHERE soundAuthor = ? AND soundName = ?;");
    bot.getTopTenSoundUsageData = soundsSQL.prepare("SELECT *, sbRequested + sbvRequested AS totalRequests FROM sounds ORDER BY totalRequests DESC LIMIT 10;");
    
    // Check if the table "playlists" exists.
    const playlistsTable = playlistsSQL.prepare("SELECT count(*) FROM sqlite_master WHERE type='table' AND name = 'playlists';").get();
    if (!playlistsTable['count(*)']) {
        // If the table isn't there, create it and setup the database correctly.
        playlistsSQL.prepare("CREATE TABLE playlists (name TEXT PRIMARY KEY, created DATETIME DEFAULT CURRENT_TIMESTAMP, userWhoAdded TEXT, guild TEXT, channel TEXT, playlistJSON TEXT);").run();
        // Ensure that the "id" row is always unique and indexed.
        playlistsSQL.prepare("CREATE UNIQUE INDEX idx_playlists_name ON playlists (name);").run();
        playlistsSQL.pragma("synchronous = 1");
        playlistsSQL.pragma("journal_mode = wal");
    }
    bot.updatePlaylist = playlistsSQL.prepare("INSERT OR REPLACE INTO playlists (name, userWhoAdded, guild, channel, playlistJSON) VALUES (@name, @userWhoAdded, @guild, @channel, @playlistJSON);");
    bot.loadPlaylist = playlistsSQL.prepare("SELECT * FROM playlists WHERE guild = @guild AND channel = @channel AND name = @name;");
    
    // For every file in the `./sounds/*` directories,
    // add that filename (minus extension) to our list
    // of available soundboard sounds.
    // The keys in `soundboardData` correspond to the
    // sound filenames. The value with that key is a
    // `people` array containing the people who said that thing.
    // This is an array because sound filenames
    // don't have to be unique between people.
    var soundAuthors = fs.readdirSync("./sounds");
    for (var i = 0; i < soundAuthors.length; i++) {
        var currentAuthor = soundAuthors[i];
        
        if (currentAuthor === "README.md" || currentAuthor.indexOf("sounds.sqlite") > -1) {
            continue;
        }
        
        var soundIDs = fs.readdirSync("./sounds/" + currentAuthor);
        for (var j = 0; j < soundIDs.length; j++) {
            var soundID = soundIDs[j].slice(0, -4);

            // Add metadata about the current sound into the sounds table
            soundsSQL.prepare("INSERT OR IGNORE INTO sounds " + 
                "(soundAuthor, soundName, sbRequested, sbvRequested) VALUES ('" +
                currentAuthor + "', '" + soundID + "', 0, 0);").run();
            
            if (!soundboardData.data[soundID]) {
                soundboardData.data[soundID] = {};
            }
            
            if (!soundboardData.data[soundID]["people"]) {
                soundboardData.data[soundID]["people"] = [];
            }
            
            soundboardData.data[soundID]["people"].push(currentAuthor);
        }
    }
    
    soundboardSystemReady = true;
    console.log('Soundboard system ready.');

    console.log("Clearing temporary file directory...");
    deleteTempFiles();
    console.log("Cleared temporary file directory.");

    updateReadyStatus();
});

// This event handler will ensure that, when a user adds/removes a reaction to a
// non-cached message, the reaction will still be caught by the bot.
// Snagged from
// https://github.com/AnIdiotsGuide/discordjs-bot-guide/blob/master/coding-guides/raw-events.md
// (THANK YOU!)
bot.on('raw', packet => {
    // We don't want this to run on unrelated packets
    if (!['MESSAGE_REACTION_ADD', 'MESSAGE_REACTION_REMOVE'].includes(packet.t)) return;
    // Grab the channel to check the message from
    const channel = bot.channels.get(packet.d.channel_id);
    // There's no need to emit if the message is cached, because the event will fire anyway for that
    if (channel.messages.has(packet.d.message_id)) return;
    // Since we have confirmed the message is not cached, let's fetch it
    channel.fetchMessage(packet.d.message_id).then(message => {
        // Emojis can have identifiers of name:id format, so we have to account for that case as well
        const emoji = packet.d.emoji.id ? `${packet.d.emoji.name}:${packet.d.emoji.id}` : packet.d.emoji.name;
        // This gives us the reaction we need to emit the event properly, in top of the message object
        const reaction = message.reactions.get(emoji);
        // Check which type of event it is before emitting
        if (packet.t === 'MESSAGE_REACTION_ADD') {
            bot.emit('messageReactionAdd', reaction, bot.users.get(packet.d.user_id));
        }
        if (packet.t === 'MESSAGE_REACTION_REMOVE') {
            bot.emit('messageReactionRemove', reaction, bot.users.get(packet.d.user_id));
        }
    });
});

// If a user says one of the messages on the left,
// the bot will respond with the message on the right
const exactMessageHandlers = {
    "cool cool cool": "cool cool cool cool cool cool",
    "ya gotta have your bot!": "ya just gotta!",
    "rad": "brad"
}

function getYouTubeVideoTitleFromURL(youTubeURL, indexInPlaylist, callback) {
    if (!youtubeAuthToken) {
        console.log("You haven't set up a YouTube API key - this will fail silently!");
        return;
    }
    
    var videoId = youTubeURL.substr(-11);
    
    var youtubeService = google.youtube('v3');
    var parameters = {
        'maxResults': '1',
        'part': 'snippet',
        'q': videoId,
        'type': 'video',
        'regionCode': 'US'
    };
    parameters['auth'] = youtubeAuthToken;
    youtubeService.search.list(parameters, function(err, response) {
        if (err) {
            console.log('The API returned an error: ' + err);
            return;
        }
        var videoTitle = response.data.items[0].snippet.title;
        callback(videoTitle, indexInPlaylist, youTubeURL);
    });
}

function getFirstYouTubeResult(query, callback, errorCallback) {
    if (!youtubeAuthToken) {
        console.log("You haven't set up a YouTube API key - this will fail silently!");
        return;
    }
    
    var youtubeService = google.youtube('v3');
    var parameters = {
        'maxResults': '1',
        'part': 'snippet',
        'q': query,
        'type': 'video',
        'regionCode': 'US'
    };
    parameters['auth'] = youtubeAuthToken;
    youtubeService.search.list(parameters, function(err, response) {
        if (err) {
            console.log('The API returned an error: ' + err);
            return;
        }

        if (response.data.items.length === 0) {
            errorCallback("No search results returned.");
            return;
        }

        var videoId = response.data.items[0].id.videoId;
        var fullUrl = "https://www.youtube.com/watch?v=" + videoId;
        var videoTitle = response.data.items[0].snippet.title;
        callback(fullUrl, videoTitle);
    });
}

var youTubePlaylist = [];
var currentYouTubePlaylistPosition = -1;
var youTubePlaylistRepeatMode = "none";

function handleNextInYouTubePlaylist() {
    if (youTubePlaylist.length > currentYouTubePlaylistPosition + 1) {
        currentYouTubePlaylistPosition++;
        handleVoiceStream(youTubePlaylist[currentYouTubePlaylistPosition]);
    }
}

function handleBackInYouTubePlaylist() {
    if (currentYouTubePlaylistPosition !== 0) {
        currentYouTubePlaylistPosition--;
        handleVoiceStream(youTubePlaylist[currentYouTubePlaylistPosition]);
    }
}

function handleListYouTubePlaylist(message) {
    var playlistArray = [];
    var numResponses = 0;
    if (youTubePlaylist.length === 0) {
        message.channel.send("Playlist is empty, boss!");
    } else {
        message.channel.send("Here's the current YouTube Playlist:\n");
        for (var i = 0; i < youTubePlaylist.length; i++) {
            getYouTubeVideoTitleFromURL(youTubePlaylist[i], i, function(title, index, originalURL) {
                indexString = index;
                if (index === currentYouTubePlaylistPosition) {
                    indexString = "🎶 " + index;
                }
                playlistArray[index] = (`${indexString}. ${title} (\`${originalURL}\`)`);
                numResponses++;
                // This guarantees that the order of the playlist is the order
                // in which the playlist is displayed in-channel to the user
                if (numResponses === youTubePlaylist.length) {
                    message.channel.send(playlistArray.join("\n"));
                }
            });
        }
    }
}

function handleClearYouTubePlaylist(message) {
    youTubePlaylist = [];
    currentYouTubePlaylistPosition = -1;
    message.channel.send("YouTube playlist cleared.");
    
    // If there's something playing, stop it.
    if (currentStreamDispatcher) {
        currentStreamDispatcher.end('playlistCleared');
    }
}

function deleteIndexFromYouTubePlaylist(message, indexToDelete) {
    indexToDelete = parseInt(indexToDelete);
    if (!youTubePlaylist[indexToDelete]) {
        message.channel.send("That playlist item doesn't exist yet, friendo!");
        return;
    }
    
    youTubePlaylist.splice(indexToDelete, 1);
    message.channel.send(index + ". " + youTubePlaylist[indexToDelete] + ' deleted from playlist.');
    
    // If a user just deleted the song they're currently listening to,
    // stop the current song.
    if (indexToDelete === currentYouTubePlaylistPosition && currentStreamDispatcher) {
        // If the next song exists in the playlist...
        if (youTubePlaylist[currentYouTubePlaylistPosition]) {
            // ...don't do anything except end the current stream dispatcher (the end
            // signal handler will handle the rest).
        } else {
            currentYouTubePlaylistPosition--;
        }
        currentStreamDispatcher.end('playlistIndexDeleted');
    }
}

async function playYouTubeAudio(filePath) {
    if (currentStreamDispatcher) {
        currentStreamDispatcher.end('newAudio');
    }
    var streamOptions = { volume: youtubeVolume, seek: 0 };
    var readStream = fs.createReadStream(filePath);
    currentStreamDispatcher = currentVoiceConnection.playStream(readStream);
    console.log(`maybeDownloadThenPlayYouTubeAudio(): checkpoint 03`);
    // When the sound has finished playing...
    currentStreamDispatcher.on("end", reason => {
        console.log(`Current Stream Dispatcher - End Event Received. Waiting a moment before running more code...`);
        // Nasty hack to get around discord.js v11 issue
        // See https://www.bountysource.com/issues/44186528-dispatcher-ends-without-a-reason
        setTimeout(() => {
            console.log(`Current Stream Dispatcher - End Event Received with Reason: ${reason}`);
            
            if (!currentVoiceChannel) {
                return;
            }
    
            // If the reasons are any of these, we don't want to do anything else.
            // We do want to continue for the following reasons:
            // 'playlistIndexDeleted'
            if (reason && ['newAudio', 'playlistCleared', 'leaving'].indexOf(reason) > -1) {
                return;
            }
            
            if (youTubePlaylistRepeatMode === "one") {
                console.log(`Repeating that last video's audio...`);
                handleVoiceStream(youTubePlaylist[currentYouTubePlaylistPosition], message);
            } else if (youTubePlaylistRepeatMode === "all" &&
                currentYouTubePlaylistPosition === (youTubePlaylist.length - 1)) {
                console.log(`Starting playlist from the beginning...`);
                currentYouTubePlaylistPosition = -1;
                handleNextInYouTubePlaylist();
            } else {
                console.log(`Calling handleNextInYouTubePlaylist()...`);
                handleNextInYouTubePlaylist();
            }
        }, 500);
    });
}

async function maybeDownloadThenPlayYouTubeAudio(url, message) {
    var youTubeVideoID = ytdl.getURLVideoID(url);
    var filePath = `temp/${youTubeVideoID}.mp3`;
    if (fs.existsSync(filePath)) {
        playYouTubeAudio(filePath);
    } else { 
        if (message) {
            message.channel.send("I don't have a copy of this audio in my cache! Gimme a sec to download it...");
        }
        console.log(`maybeDownloadThenPlayYouTubeAudio(): checkpoint 01`);
        // var input = ytdl(url, { "filter": "audioonly" });
        var input = ytdl(url);
        console.log(`maybeDownloadThenPlayYouTubeAudio(): checkpoint 02`);
        input.pipe(fs.createWriteStream(`temp/${youTubeVideoID}.mp3`));
        input.on("end", () => {
            if (message) {
                message.channel.send("Audio downloaded. Enjoy!");
            }
            playYouTubeAudio(filePath);
        });
    }
}

function handleVoiceStream(filePathOrUrl, message) {
    var filePath = false;
    var youtubeUrlToPlay = false;
    
    // The assumption here is that the caller has already
    // verified that what's passed to `handleVoiceStream()` is
    // either a valid YouTube URL or a valid local file path.
    if (filePathOrUrl.indexOf("youtube.com") > -1) {
        youtubeUrlToPlay = filePathOrUrl;
    } else {
        filePath = filePathOrUrl;
    }
    
    var playAudio = function() {
        // If what we're trying to play is a local file...
        if (filePath) {
            if (currentStreamDispatcher) {
                currentStreamDispatcher.end('newAudio');
            }
            // This only works completely when using discord.js v11 and Node.js v8
            // Node.js v9 and newer won't play short files completely
            // Apparently this is fixed in discord.js v12, but I couldn't get the master
            // branch to work.
            currentStreamDispatcher = currentVoiceConnection.playFile(filePath);
            // When the sound has finished playing...
            currentStreamDispatcher.on("end", () => {
                // Nasty hack to get around discord.js v11 issue
                // See https://www.bountysource.com/issues/44186528-dispatcher-ends-without-a-reason
                setTimeout(() => {
                    currentStreamDispatcher = false;
                }, 500);
            });
        } else if (youtubeUrlToPlay) {
            console.log(`handleVoiceStream -> playAudio -> ${youtubeUrlToPlay}...`);
            maybeDownloadThenPlayYouTubeAudio(youtubeUrlToPlay, message);
        } else {
            return console.log("What you want to play is not a file path or a YouTube URL.");
        }
    }
    
    // If the bot isn't already in a voice channel...
    if (!currentVoiceChannel) {
        // Set `currentVoiceChannel` to the voice channel
        // that the user who issued the command is in
        currentVoiceChannel = message.member.voiceChannel || false;
        
        // If the user isn't in a voice channel...
        if (!currentVoiceChannel) {
            if (message) {
                return message.channel.send("enter a voice channel first.");
            }
        }
    
        currentVoiceChannel.join()
        .then(connection => {
            currentVoiceConnection = connection;
            playAudio();
        }).catch(console.error);
    } else {
        if (!currentVoiceConnection) {
            if (message) {
                message.channel.send("for some reason, i'm in a voice channel but " +
                    "i don't have a voice connection :(");
            }
        } else {
            playAudio();
        }
    }
}

var lastThreeMessages = {};
function handleThreeMessages(message) {
    if (!lastThreeMessages[message.channel.id]) {
        lastThreeMessages[message.channel.id] = {
            "counter": 0,
            "lastMessage": "",
            "lastTwoAuthors": []
        };
    }

    if (lastThreeMessages[message.channel.id].counter === 2 &&
        message.content.normalize("NFC") === lastThreeMessages[message.channel.id].lastMessage.normalize("NFC") &&
        lastThreeMessages[message.channel.id].lastTwoAuthors.indexOf(message.author.id) === -1) {

        lastThreeMessages[message.channel.id].counter = 0;
        lastThreeMessages[message.channel.id].lastTwoAuthors = [];
        lastThreeMessages[message.channel.id].lastMessage = "";

        if (message.content.length > 0) {
            message.channel.send(message.content);
        }
    } else if (message.content.normalize("NFC") === lastThreeMessages[message.channel.id].lastMessage.normalize("NFC") && 
        lastThreeMessages[message.channel.id].lastTwoAuthors.indexOf(message.author.id) === -1 &&
        message.author.id !== "500452185314820107") {
        
        lastThreeMessages[message.channel.id].counter++;
    } else {
        lastThreeMessages[message.channel.id].counter = 0;
    }

    lastThreeMessages[message.channel.id].lastTwoAuthors.unshift(message.author.id);
    lastThreeMessages[message.channel.id].lastTwoAuthors = lastThreeMessages[message.channel.id].lastTwoAuthors.slice(0, 2);
    lastThreeMessages[message.channel.id].lastMessage = message.content.normalize("NFC");
}

const QUOTE_INTERVAL_HEADERS = [
    "quotebot here with a funny quote:\n",
    "giving you random quotes at some interval is my honor:\n",
    "i hope you like this quote as much as i enjoyed retrieving it:\n",
    "dispensing quote:\n",
    "unleashing quote:\n"
];
function sendRandomQuote(guildID, channelID, prependWithHeader) {
    var result = bot.getRandomQuote.get(guildID, channelID);
    if (result) {
        var messageToSend = `#${result.id} ${result.quote}`;
        if (prependWithHeader) {
            messageToSend = QUOTE_INTERVAL_HEADERS[Math.floor(Math.random() * QUOTE_INTERVAL_HEADERS.length)] + messageToSend;
        }
        bot.channels.get(channelID).send(messageToSend);
    }
}

var currentQuoteIntervals = [];
const MS_PER_SEC = 1000;
const MIN_INTERVAL_S = 60;
const MAX_INTERVAL_S = 157700000; // 5 years
const QUOTE_INTERVAL_ERRORS_TOO_SHORT = [
    "i really hate that you just tried to set an interval with that short of a delay.",
    "i almost feel like you're trying to sabotage me. try a longer delay",
    "are you serious? come on. that's too short of a delay",
    "i can tell, you're trying to get me in trouble with the discord rate limiter. try a longer delay"
];
const QUOTE_INTERVAL_ERRORS_TOO_LONG = [
    "the last time someone gave me a delay this long, i exploded",
    "please don't do this to me",
    "i don't understand numbers that big"
];
function startQuoteInterval(author, guild, channel, intervalS, isNewInterval, message) {
    if (isNaN(parseInt(intervalS))) {
        bot.channels.get(channel).send("🙄");
        return;
    }

    if (parseInt(intervalS) < MIN_INTERVAL_S) {
        bot.channels.get(channel).send(QUOTE_INTERVAL_ERRORS_TOO_SHORT[Math.floor(Math.random() * QUOTE_INTERVAL_ERRORS_TOO_SHORT.length)]);
        return;
    }

    if (parseInt(intervalS) > MAX_INTERVAL_S) {
        bot.channels.get(channel).send(QUOTE_INTERVAL_ERRORS_TOO_LONG[Math.floor(Math.random() * QUOTE_INTERVAL_ERRORS_TOO_LONG.length)]);
        return;
    }

    currentQuoteIntervals.push({
        "channelID": channel,
        "interval": setInterval(sendRandomQuote, intervalS * MS_PER_SEC, guild, channel, false)
    });

    if (isNewInterval) {
        var quoteIntervalSQLData = {
            userWhoAdded: author,
            guild: guild,
            channel: channel,
            intervalS: intervalS
        }
        var id = bot.setQuoteInterval.run(quoteIntervalSQLData).lastInsertRowid;
        message.channel.send("Quote Interval added to database with ID " + id);
        sendRandomQuote(guild, channel);
    }
}

// Handle all incoming messages
bot.on('message', function (message) {
    // Don't do anything if we're not ready yet
    if (!isReady) {
        return;
    }

    handleThreeMessages(message);
    
    // A little easter egg :) UB3R-B0T responds to "cool" with "cool cool cool".
    // If a user tries saying "cool cool cool" (and not UB3R-B0T), the bot will get mad :D
    if (message.content === "cool cool cool" && message.author.id !== "85614143951892480") {
        message.channel.send(">:(");
    // See `var exactMessageHandlers` above.
    } else if (message.content in exactMessageHandlers) {
        message.channel.send(exactMessageHandlers[message.content]);
    // If the very first character in a user's message is an "!", parse it as a command.
    } else if (message.content.substring(0, 1) == '!') {
        console.log("command: " + message.content);
        // Split up arguments to the command based on spaces
        var args = message.content.substring(1).split(' ');
        // The command is the first "argument"
        var cmd = args[0];
        // After this operation, the `args` array will only contain arguments to `cmd`
        args = args.splice(1);

		// If the "command" is actually an emoji, display the emoji instead of parsing the command.
		// This would seem like a bug if you named one of your emojis the same as one of the commands,
		// but I don't expect that to happen. That'd be weird.
		if (availableEmojis[cmd.toLowerCase()]) {
			message.channel.send({
				file: "./bigEmoji/" + availableEmojis[cmd.toLowerCase()]
			});
			return;
		}
        
        // Switch based on the command given
        switch(cmd) {
            // This command will display a big emoji in the channel
            case 'e':
                var emojiName = args[0];
                
                if (emojiName === "refresh") {
                    refreshEmoji();
                    message.channel.send("Refreshing emoji system...Did you add something good?");
                } else if (emojiName && availableEmojis[emojiName.toLowerCase()]) {
                    message.channel.send({
                        file: "./bigEmoji/" + availableEmojis[emojiName.toLowerCase()]
                    });
                } else {
                    message.channel.send(errorMessages[cmd]);
                }
            break;
            // This command will display usage data about a sound
            case 'soundStats':
                var messageToSend = "";
                var result;
                    
                // This argument dictates which soundID the user wants info about
                if (args[0]) {
                    // If a user supplies this argument, they only want info about a soundID said by a specific person
                    if (args[1]) {
                        // If a user supplies this argument, they want stats about all of a specific person's sounds
                        if (args[0] === "*") {
                            result = bot.getSpecificSoundUsageDataByAuthor.all(args[1]);
                            
                            if (!result) {
                                messageToSend = "No results found for that person."
                            } else {
                                for (var i = 0; i < result.length; i++) {
                                    var numTimesRequested = result[i]["sbRequested"] + result[i]["sbvRequested"];
                                    
                                    messageToSend += '"' + result[i]["soundAuthor"] + " - " + result[i]["soundName"] +
                                    "\" requested " + numTimesRequested +
                                    " time" + (numTimesRequested === 1 ? "" : "s") + ".\n";
                                }
                            }
                        // If a user doesn't use "*" as args[0], they want stats about a soundID said by a specific person
                        } else {
                            result = bot.getSpecificSoundUsageDataWithAuthor.get(args[1], args[0]);
                            
                            if (!result) {
                                messageToSend = "No results found for that person and soundID."
                            } else {
                                var numTimesRequested = result["sbRequested"] + result["sbvRequested"];
                                
                                messageToSend += '"' + result["soundAuthor"] + " - " + result["soundName"] +
                                "\" requested " + numTimesRequested +
                                " time" + (numTimesRequested === 1 ? "" : "s") + ".\n";
                            }
                        }
                    // If a user just supplies a soundID, return stats data about sounds with that ID said by everyone who said it
                    } else {
                        result = bot.getSpecificSoundUsageData.all(args[0]);
                        
                        if (!result) {
                            messageToSend = "No results found for that soundID."
                        } else {
                            for (var i = 0; i < result.length; i++) {
                                var numTimesRequested = result[i]["sbRequested"] + result[i]["sbvRequested"];
                                
                                messageToSend += '"' + result[i]["soundAuthor"] + " - " + result[i]["soundName"] +
                                "\" requested " + numTimesRequested +
                                " time" + (numTimesRequested === 1 ? "" : "s") + ".\n";
                            }
                        }                        
                    }
                // No argument means they want total usage stats
                } else {
                    result = bot.getTopTenSoundUsageData.all();
                    for (var i = 0; i < result.length; i++) {
                        var numTimesRequested = result[i]["sbRequested"] + result[i]["sbvRequested"];
                        
                        messageToSend += '"' + result[i]["soundAuthor"] + " - " + result[i]["soundName"] +
                        "\" requested " + numTimesRequested +
                        " time" + (numTimesRequested === 1 ? "" : "s") + ".\n";
                    }
                }
                
                message.channel.send(messageToSend);
            break;
            // This command will upload a sound from the soundboard to the channel
            case 'sb':
                // If the user input a soundID...
                if (args[0]) {
                    var soundID = args[0];
                    var person = args[1];
                    
                    // If this isn't a valid soundID...
                    if (!soundboardData.data[soundID]) {
                        message.channel.send('soundID invalid. valid soundIDs:\n' + Object.keys(soundboardData.data).join(', ') + "\n\nsome soundids are said by more than 1 person. good luck figuring out who's who");
                        return;
                    // If the user input a person, but that person isn't associated
                    // with the input soundID...
                    } else if (person && soundboardData.data[soundID].people.indexOf(person) < 0) {
                        message.channel.send('person invalid. valid people for this sound:\n' + soundboardData.data[soundID].people.join(', '));
                        return;
                    }
                    
                    // If the user didn't input a person...
                    if (!person) {
                        // ...choose a random person associated with the soundID.
                        person = soundboardData.data[soundID].people[Math.floor(Math.random() * soundboardData.data[soundID].people.length)];
                    }
                    
                    var sbUsageData = {
                        soundAuthor: person,
                        soundName: soundID
                    }
                    var result = bot.incrementSBUsageData.run(sbUsageData);
                    result = bot.getSpecificSoundUsageDataWithAuthor.get(person, soundID);
                    var sbReplyMessage = "";
                    if (result) {
                        sbReplyMessage = '"' + person + " - " + soundID + "\" requested " +
                            (result.sbRequested + result.sbvRequested) +
                            " time" + (result.sbRequested + result.sbvRequested === 1 ? "" : "s") + ".";
                    }
                    
                    // Attach the appropriate sound to the message.
                    message.channel.send(sbReplyMessage, {
                        file: "./sounds/" + person + "/" + soundID + '.mp3'
                    });
                // If the user did not input a soundID...
                } else {
                    message.channel.send(errorMessages[cmd]);
                }
            break;
            // This command will speak a sound from the soundboard in the voice channel that the command
            // giver is in.
            case 'sbv':         
                // If the user input a soundID...       
                if (args[0]) {
                    var soundID = args[0];
                    var person = args[1];
                    
                    // If this isn't a valid soundID...
                    if (!soundboardData.data[soundID]) {
                        message.channel.send('soundID invalid. valid soundIDs:\n' + Object.keys(soundboardData.data).join(', ') + "\n\nsome soundids are said by more than 1 person. good luck figuring out who's who");
                        return;
                    // If the user input a person, but that person isn't associated
                    // with the input soundID...
                    } else if (person && soundboardData.data[soundID].people.indexOf(person) < 0) {
                        message.channel.send('person invalid. valid people for this sound:\n' + soundboardData.data[soundID].people.join(', '));
                        return;
                    }
                    
                    // If the user didn't input a person...
                    if (!person) {
                        // ...choose a random person associated with the soundID.
                        person = soundboardData.data[soundID].people[Math.floor(Math.random() * soundboardData.data[soundID].people.length)];
                    }
                    
                    var sbvUsageData = {
                        soundAuthor: person,
                        soundName: soundID
                    }
                    var result = bot.incrementSBVUsageData.run(sbvUsageData);
                    result = bot.getSpecificSoundUsageDataWithAuthor.get(person, soundID);
                    if (result) {
                        var sbvReplyMessage = '"' + person + " - " + soundID +
                            "\" requested " + (result.sbRequested + result.sbvRequested) +
                            " time" + (result.sbRequested + result.sbvRequested === 1 ? "" : "s") + ".";
                        message.channel.send(sbvReplyMessage);
                    }
                    
                    var filePath = "./sounds/" + person + "/" + soundID + '.mp3';
                    console.log("command: sbv", "\nsoundID: " + soundID, "\nperson: " + person, "\npath: " + filePath + "\n");
                    
                    
                    if (currentStreamDispatcher) {
                        currentStreamDispatcher.setVolume(1.0);
                    }
                    handleVoiceStream(filePath, message);
                // If the user did not input a soundID...
                } else {
                    message.channel.send(errorMessages[cmd]);
                }
            break;
            case 'y':
                if (args[0]) {
                    // If the user directly input a YouTube video to play...   
                    if (args[0].indexOf("youtube.com") > -1) {
                        message.channel.send(`Adding \`${args[0]}\` to the \`yp\`.`);
                        youTubePlaylist.push(args[0]);
    
                        if (!currentStreamDispatcher) {
                            currentYouTubePlaylistPosition++;
                            handleVoiceStream(youTubePlaylist[currentYouTubePlaylistPosition], message);
                        }
                    // If the user is searching for a video...   
                    } else {
                        var searchQuery = args.join(' ');
                        getFirstYouTubeResult(searchQuery, function(youtubeUrl, title) {
                            message.channel.send(`Adding "${title}" from ${youtubeUrl} to the \`yp\``);
                            youTubePlaylist.push(youtubeUrl);
    
                            if (!currentStreamDispatcher) {
                                currentYouTubePlaylistPosition++;
                                handleVoiceStream(youTubePlaylist[currentYouTubePlaylistPosition], message);
                            }
                        }, function() {
                            message.channel.send(`There were no YouTube results for the query "${searchQuery}"`);
                        });
                    }
                } else {
                    message.channel.send(errorMessages[cmd]);
                }
            break;
            case 'yp':
                if (args[0]) {
                    var playlistCommand = args[0];
                    if (playlistCommand === "next") {
                        handleNextInYouTubePlaylist();
                    } else if (playlistCommand === "back" || playlistCommand === "prev" || playlistCommand === "previous") {
                        handleBackInYouTubePlaylist();
                    } else if (playlistCommand === "list") {
                        if (args[1]) {
                            if (args[1] === "save") {
                                if (args[2]) {
                                    var playlistName = args[2];
                                    var playlistData = {
                                        name: playlistName,
                                        userWhoAdded: message.author.id,
                                        guild: message.guild.id,
                                        channel: message.channel.id,
                                        playlistJSON: JSON.stringify(youTubePlaylist)
                                    }
                                    var id = bot.updatePlaylist.run(playlistData).lastInsertRowid;
                                    message.channel.send("Playlist added to database with ID " + id);
                                } else {
                                    message.channel.send(`Please specify a playlist name: \`yp list save <playlist name>\``);
                                }
                            } else if (args[1] === "load") {
                                if (args[2]) {
                                    var playlistName = args[2];
                                    var requestData = {
                                        name: playlistName,
                                        guild: message.guild.id,
                                        channel: message.channel.id
                                    }
                                    var results = bot.loadPlaylist.get(requestData);
                                    if (results) {
                                        var playlistJSON = JSON.parse(results.playlistJSON);

                                        if (playlistJSON.length === 0) {
                                            message.channel.send(`That playlist didn't have any songs in it! Silly.`);
                                            return;
                                        }

                                        for (var i = 0; i < playlistJSON.length; i++) {
                                            youTubePlaylist.push(playlistJSON[i]);
                                        }
                                        message.channel.send(`Playlist loaded.`);
    
                                        if (!currentStreamDispatcher) {
                                            currentYouTubePlaylistPosition++;
                                            handleVoiceStream(youTubePlaylist[currentYouTubePlaylistPosition], message);
                                        }
                                    } else {
                                        message.channel.send(`I couldn't find a playlist named "${playlistName}" in my database.`);
                                    }
                                } else {
                                    message.channel.send(`Please specify a playlist name: \`yp list load <playlist name>\``);
                                }
                            } else if (args[1] === "show" || args[1] === "display") {
                                if (args[2]) {
                                    var playlistName = args[2];
                                    var requestData = {
                                        name: playlistName,
                                        guild: message.guild.id,
                                        channel: message.channel.id
                                    }
                                    var results = bot.loadPlaylist.get(requestData);
                                    if (results) {
                                        var playlistJSON = JSON.parse(results.playlistJSON);

                                        if (playlistJSON.length === 0) {
                                            message.channel.send(`That playlist didn't have any songs in it!`);
                                            return;
                                        }

                                        message.channel.send(`Here's the playlist called \`${playlistName}\`:`);
                                        var playlistArray = [];
                                        var numResponses = 0;
                                        for (var i = 0; i < playlistJSON.length; i++) {
                                            getYouTubeVideoTitleFromURL(playlistJSON[i], i, function(title, index, originalURL) {
                                                indexString = index;
                                                if (youTubePlaylist[currentYouTubePlaylistPosition] === originalURL) {
                                                    indexString = "🎶 " + index;
                                                }
                                                playlistArray[index] = (`${indexString}. ${title} (\`${originalURL}\`)`);
                                                numResponses++;
                                                // This guarantees that the order of the playlist is the order
                                                // in which the playlist is displayed in-channel to the user
                                                if (numResponses === playlistJSON.length) {
                                                    message.channel.send(playlistArray.join("\n"));
                                                }
                                            });
                                        }
                                    } else {
                                        message.channel.send(`I couldn't find a playlist named "${playlistName}" in my database.`);
                                    }
                                } else {
                                    message.channel.send(`Please specify a playlist name: \`yp list show <playlist name>\``);
                                }
                            } else {
                                message.channel.send(errorMessages[cmd]);
                            }
                        } else {
                            handleListYouTubePlaylist(message);
                        }
                    } else if (playlistCommand === "clear") {
                        handleClearYouTubePlaylist(message);
                    } else if (playlistCommand === "del" || playlistCommand === "delete") {
                        if (args[1]) {
                            deleteIndexFromYouTubePlaylist(message, args[1]);
                        } else {
                            message.channel.send(errorMessages[cmd]);
                        }
                    } else if (playlistCommand === "repeat") {
                        if (args[1] === "none" || args[1] === "one" || args[1] === "all") {
                            youTubePlaylistRepeatMode = args[1];
                            message.channel.send("YouTube playlist repeat mode is now: " + youTubePlaylistRepeatMode);
                        } else {
                            message.channel.send("YouTube playlist repeat mode is currently: " + youTubePlaylistRepeatMode);
                        }
                    } else {
                        message.channel.send(errorMessages[cmd]);
                    }
                } else {
                    message.channel.send(errorMessages[cmd]);
                }
            break;
            case 'next':
                handleNextInYouTubePlaylist();
            break;
            case 'back':
            case 'prev':
            case 'previous':
                handleBackInYouTubePlaylist();
            break;
            case 'pause':
                if (currentStreamDispatcher) {
                    currentStreamDispatcher.pause();
                }
            break;
            case 'resume':
                if (currentStreamDispatcher) {
                    currentStreamDispatcher.resume();
                }
            break;
            case 'v':
                if (args[0]) {
                    if (args[0] === "pause") {
                        if (currentStreamDispatcher) {
                            currentStreamDispatcher.pause();
                        }
                    } else if (args[0] === "resume" || args[0] === "play") {
                        if (currentStreamDispatcher) {
                            currentStreamDispatcher.resume();
                        }
                    } else if (args[0] === "vol" || args[0] === "volume") {
                        if (args[1]) {
                            var volume = parseFloat(args[1]);
                            if (volume <= 2 && volume >= 0) {
                                youtubeVolume = volume;
                                message.channel.send("set youtube music volume to " + youtubeVolume);

                                if (currentStreamDispatcher) {
                                    var currentVolume = currentStreamDispatcher.volume;
                                    var stepSize = (youtubeVolume - currentVolume) / 20;
                                    var counter = 0;
                                    var interval = setInterval(function() {
                                        currentVolume = currentStreamDispatcher.volume;
                                        if (counter >= 20) {
                                            clearInterval(interval);
                                            return;
                                        } else {
                                            currentStreamDispatcher.setVolume(currentVolume + stepSize);
                                        }
                                        counter++;
                                    }, 10);
                                }
                            } else {
                                message.channel.send("volume must be between 0 and 2");
                            }
                        } else {
                            if (currentStreamDispatcher) {
                                message.channel.send(currentStreamDispatcher.volume);
                            } else {
                                message.channel.send("There's no `currentStreamDispatcher`, boss! Start playin' something!");
                            }
                        }
                    }                    
                } else {
                    message.channel.send(errorMessages[cmd]);
                }
            break;
            // This command will force the bot to leave the voice channel that it's in.
            case 'leave':
                if (currentVoiceChannel) {
                    if (currentStreamDispatcher) {
                        currentStreamDispatcher.end('leaving');
                    }
                    currentVoiceChannel.leave();
                    currentVoiceChannel = false;
                    currentVoiceConnection = false;
                } else {
                    message.channel.send(errorMessages[cmd]);
                }
            break;
            case 'roleColor':
                if (args[0]) {
                    if (args[0].startsWith("#") && args[0].length === 7) {
                        var hexColor = args[0];
                        var guildMember = message.member;
                        var memberRoles = guildMember.roles;
                        memberRoles.tap(function(value, key, map) {
                            if (value.name === "@everyone") {
                                return;
                            }
                            value.setColor(hexColor, "User set their color")
                            .then(updated => {
                                console.log(`Set color of role named ${value.name} to ${value.color}`);
                                message.channel.send("Gorgeous.");
                            })
                            .catch(console.error);
                        });
                    } else if (args[0] === "auto") {
                        // hex color by default
                        console.log(`Trying to automatially get the dominant color from ${message.author.avatarURL}...`);
                        var filename = `${__dirname}${path.sep}temp${path.sep}${Date.now()}.${(message.author.avatarURL).split('.').pop().split('?')[0]}`;
                        console.log(`Saving profile pic to ${filename}...`);
                        const file = fs.createWriteStream(filename);
                        const request = https.get(message.author.avatarURL, function(response) {
                            response.pipe(file);

                            file.on('finish', function() {
                                file.close(function() {
                                    console.log(`Saved profile pic to ${filename}!`);
                                    console.log(`Trying to get dominant color...`);
                                    getDominantColor(filename, function(err, outputColorObj) {
                                        fs.unlinkSync(filename);

                                        if (err) {
                                            console.log(`Error when getting dominant color: ${err}`);
                                            message.channel.send("Yikes, something bad happened on my end. Sorry. Blame Zach.");
                                            return;
                                        }

                                        var outputColorHex = outputColorObj.hex;

                                        var outputColorRgba = outputColorObj.rgba;
                                        var r = parseInt(outputColorRgba[0]);
                                        var g = parseInt(outputColorRgba[1]);
                                        var b = parseInt(outputColorRgba[2]);
                                        var outputColorHue;
                                        var maxRGB = Math.max(r, g, b);
                                        var minRGB = Math.min(r, g, b);
                                        if (maxRGB === r) {
                                            outputColorHue = 60 * (g - b) / (maxRGB - minRGB);
                                        } else if (maxRGB === g) {
                                            outputColorHue = 60 * (2 + (b - r) / (maxRGB - minRGB));
                                        } else {
                                            outputColorHue = 60 * (4 + (r - g) / (maxRGB - minRGB));
                                        }
                                        outputColorHue = Math.round(outputColorHue);
                                        if (outputColorHue < 0) {
                                            outputColorHue += 360;
                                        }
                                        console.log(`\`outputColorHue\` is ${outputColorHue}`);

                                        if (!outputColorHue) {
                                            console.log(`Error when getting dominant color: No \`outputColorHue\`. outputColorObj: ${JSON.stringify(outputColorObj)}`);
                                            message.channel.send("Yikes, something bad happened on my end. Sorry. Blame Zach, and he'll check the logs.");
                                            return;
                                        }

                                        var scheme = new ColorScheme;
                                        scheme.from_hue(outputColorHue).scheme('contrast');
                                        var colorSchemeColors = scheme.colors();    
                                        colorSchemeColors = colorSchemeColors.map(i => '#' + i);                                    

                                        if (outputColorHex.length === 8) {
                                            outputColorHex = outputColorHex.slice(0, 6);
                                        }
                                        outputColorHex = `#${outputColorHex}`;
        
                                        var guildMember = message.member;
                                        var memberRoles = guildMember.roles;
                                        memberRoles.tap(function(value, key, map) {
                                            if (value.name === "@everyone") {
                                                return;
                                            }
                                            value.setColor(outputColorHex, `User set their color automatically based on their profile picture.`)
                                            .then(updated => {
                                                console.log(`Automatically set color of role named ${value.name} to ${outputColorHex} based on their profile picture: ${message.author.avatarURL}`);
                                                message.channel.send(`I've selected ${outputColorHex} for you. You might also like one of the following colors:\n${colorSchemeColors.join(', ')}`);
                                            })
                                            .catch(console.error);
                                        });
                                    });
                                });
                            });
                        });
                    } else {
                        message.channel.send(errorMessages[cmd]);
                    }
                } else {
                    var guildMember = message.member;
                    var memberRoles = guildMember.roles;
                    var messageToSend = "Your role colors:\n";
                    memberRoles.tap(function(value, key, map) {
                        if (value.name === "@everyone") {
                            return;
                        }
                        messageToSend += `${value}: ${value.hexColor}\n`;
                    });
                    message.channel.send(messageToSend);
                }
            break;
            // These commands will display the help message
            case 'help':
            case 'commands':
            case 'halp':
                const helpMsg = "current commands:\n!" + Object.keys(errorMessages).join('\n!');
                message.channel.send(helpMsg);
            break;
            // Handles quote database operations
            case 'quote':
                var messageToSend = false;
                // There shouldn't be more than two arguments.
                if (args[3]) {
                    message.channel.send(errorMessages[cmd]);
                    return;
                // If there are 3 arguments...
                } else if (args[2]) {
                    if (args[0] === "interval" && (args[1] === "del" || args[1] === "delete")) {
                        for (var i = 0; i < currentQuoteIntervals.length; i++) {
                            if (currentQuoteIntervals[i].channelID === message.channel.id) {
                                clearInterval(currentQuoteIntervals[i].interval);
                            }
                        }

                        // delete the quoteInterval if possible
                        var result = bot.deleteQuoteInterval.run(message.guild.id, message.channel.id, args[2]);
                        
                        // If the quoteInterval was deleted...
                        if (result.changes > 0) {
                            messageToSend = "quote interval with id " + args[2] + " deleted.";
                        } else {
                            messageToSend = "quote interval with id " + args[2] + " not found.";
                        }
                    } else {
                        message.channel.send(errorMessages[cmd]);
                    }
                // If there are 2 arguments...
                } else if (args[1]) {
                    if (args[0] === "delete") {
                        // delete the quote if possible
                        var result = bot.deleteQuote.run(message.guild.id, message.channel.id, args[1]);
                        
                        // If the quote was deleted...
                        if (result.changes > 0) {
                            messageToSend = "quote with id " + args[1] + " deleted.";
                        } else {
                            messageToSend = "quote with id " + args[1] + " not found.";
                        }
                    } else if (args[0] === "interval") {
                        startQuoteInterval(message.author.id, message.guild.id, message.channel.id, args[1], true, message);
                        return;
                    } else {
                        message.channel.send(errorMessages[cmd]);
                        return;
                    }
                // If there's one argument...
                } else if (args[0]) {
                    // ...get the quote with that ID from the DB (if it exists)
                    var result = bot.getQuote.get(message.guild.id, message.channel.id, args[0]);
                    if (result) {
                        messageToSend = "#" + result.id + " " + result.quote;
                    } else {
                        messageToSend = "no quotes with that ID";
                    }
                // No arguments...
                } else {
                    // ...get a random quote from the DB
                    sendRandomQuote(message.guild.id, message.channel.id);
                    return;
                }
                
                // Send the relevant message to the channel
                message.channel.send(messageToSend || "you haven't saved any quotes in this channel yet");
            break;
         }
     // See `var botMentionMessageHandlers` below.
     } else if (message.content.includes("<@500452185314820107>") && message.author.id !== "500452185314820107") {
        // Used below :)
        const greetings = ["sup?", "howdy, pard!", "ayyo :)", "g'day!", "trevor hacked me once", "guten tag c:"];
        // If a user @mentions the bot, and their message contains
        // one of the strings on the left (case insensitive),
        // the bot will respond with one of the messages on the right at random
        const botMentionMessageHandlers = {
            "fuck you": ["NO FCUK YUOU"],
            "yo": greetings,
            "hey": greetings,
            "hi": greetings,
            "sic 'em": ["http://gph.is/XHUbrW"],
            "trevor is causing me undue stress": ["i know, right? just ignore him, it'll all be okay. i would never retaliate against him but i will say that i do understand where you're coming from. this situation isn't worth your time or energy. go have some water, eat some food. this conversation will all blow over soon and everyone involved will forget about it within the next few hours. i love you"],
            "bye": ["no"],
            "rude": ["i'm so sorry D:", "it'll never happen again", "i'm just a robot with no sense of morality, please!!! :sob:"]
        }
        
        var lowerCaseMessage = message.content.toLowerCase();
        
        for (var key in botMentionMessageHandlers) {
            if (lowerCaseMessage.includes(key)) {
                message.channel.send(botMentionMessageHandlers[key][Math.floor(Math.random() * botMentionMessageHandlers[key].length)]);
            }
        }
    }
});

// Everything below this comment is related to the quote database system.
// Each new QuoteObject contains data about the quote that a user is currently constructing
function QuoteObject(quoteAdderObject, quoteGuild, quoteChannel, firstMessageObject, endQuoteMessageID) {
    this.quoteAdderObject = quoteAdderObject;
    this.quoteGuild = quoteGuild;
    this.quoteChannel = quoteChannel;
    this.messageObjectsInQuote = [firstMessageObject];
    this.endQuoteMessageID = endQuoteMessageID;
}
function formatQuote(quoteObject) {
    // formattedQuote will contain the return value, which is used, for example, for what we might store in the DB as the final quote.
    let formattedQuote = false;
    
    // For every message in the currentQuoteObject...
    var messageIDsUsed = [];
    while (quoteObject.messageObjectsInQuote.length !== messageIDsUsed.length) {
        // Find the oldest message in the array first...
        var currentOldestMessageObjectIndex = 0;
        var currentOldestMessageObject = null;
        for (var j = 0; j < quoteObject.messageObjectsInQuote.length; j++) {
            if (messageIDsUsed.includes(quoteObject.messageObjectsInQuote[j].id)) {
                continue;
            }

            if (!currentOldestMessageObject || quoteObject.messageObjectsInQuote[j].createdTimestamp < currentOldestMessageObject.createdTimestamp) {
                currentOldestMessageObjectIndex = j;
                currentOldestMessageObject = quoteObject.messageObjectsInQuote[currentOldestMessageObjectIndex];
            }
        }
        
        // Start the formatted quote text string with the date of the oldest message in the quote
        if (!formattedQuote) {
            var currentMessageTimestamp_YMD = moment(currentOldestMessageObject.createdTimestamp).format('YYYY-MM-DD')
            formattedQuote = currentMessageTimestamp_YMD;
        }
        
        // Grab some data about the current-oldest message object in our quoteObject...
        var currentPartOfQuoteAuthor = currentOldestMessageObject.author.toString();
        var currentPartOfQuoteTimestamp_formatted = moment(currentOldestMessageObject.createdTimestamp).format('hh:mm:ss');
        var currentPartOfQuoteContent = currentOldestMessageObject.content;
        
        // Add to the formatted quote
        formattedQuote += "\n" + currentPartOfQuoteAuthor +
            " [" + currentPartOfQuoteTimestamp_formatted + "]: " + currentPartOfQuoteContent;

        messageIDsUsed.push(currentOldestMessageObject.id);
    }

    return formattedQuote;
}
// This array holds all of the quotes that the bot is currently keeping track of.
var activeQuoteObjects = [];
function getQuoteContinueMessage(userID) {
    let quoteContinueMessage = "keep tagging parts of the quote with 🔠 or react to this message with 🔚 to save it.";
    quoteContinueMessage = "<@" + userID + ">, " + quoteContinueMessage;
    return quoteContinueMessage;
}
function updateEndQuoteMessage(currentChannel, quoteObject) {
    // This message is posted right after a new user starts constructing a new quote.
    let quoteContinueMessage = getQuoteContinueMessage(quoteObject.quoteAdderObject.id);

    // Get the `Message` object associated with the `endQuoteMessageID` associated with the quote to which the user is adding.
    currentChannel.fetchMessage(quoteObject.endQuoteMessageID)
    .then(message => {
        // Edit the "Quote End Message" with a preview of the quote that the user is currently building.
        message.edit(quoteContinueMessage + "\nHere's a preview of your quote:\n\n" + formatQuote(quoteObject));
    });
}
bot.on('messageReactionRemove', (reaction, user) => {
    if (reaction.emoji.name === "🔠" || reaction.emoji.name === "🔡") {
        // Start off this index at -1
        let currentActiveQuoteIndex = -1;
        // If it exists, find the quote object in the activeQuoteObjects array
        // that the user who reacted is currently constructing
        for (var i = 0; i < activeQuoteObjects.length; i++) {
            if (activeQuoteObjects[i].quoteAdderObject.toString() === user.toString()) {
                currentActiveQuoteIndex = i;
                break;
            }
        }
        
        if (currentActiveQuoteIndex > -1) {
            for (var i = 0; i < activeQuoteObjects[currentActiveQuoteIndex].messageObjectsInQuote.length; i++) {
                if (reaction.message.id === activeQuoteObjects[currentActiveQuoteIndex].messageObjectsInQuote[i].id) {
                    activeQuoteObjects[currentActiveQuoteIndex].messageObjectsInQuote.splice(i, 1);

                    if (activeQuoteObjects[currentActiveQuoteIndex].messageObjectsInQuote.length === 0) {
                        // Tell the user they bailed.
                        reaction.message.channel.fetchMessage(activeQuoteObjects[currentActiveQuoteIndex].endQuoteMessageID)
                        .then(message => {
                            // Edit the "Quote End Message" with a preview of the quote that the user is currently building.
                            message.edit(`<@${user.id}>, you have removed all messages from the quote you were building. Start a new one by reacting to a message with 🔠!`);
                            console.log(user.toString() + " bailed while adding a new quote.");
                        });

                        // Remove the current QuoteObject from the activeQuoteObjects array
                        activeQuoteObjects.splice(currentActiveQuoteIndex, 1);
                        return;
                    }

                    // Update the end quote message with the new preview of the quote.
                    updateEndQuoteMessage(reaction.message.channel, activeQuoteObjects[currentActiveQuoteIndex]);
                    return;
                }
            }
        }
    }
});
bot.on('messageReactionAdd', (reaction, user) => {
    // If the user reacted to a message with the "ABCD" emoji...
    if (reaction.emoji.name === "🔠" || reaction.emoji.name === "🔡") {
        if (!reaction.message.content || reaction.message.content.length <= 0) {
            reaction.message.channel.send(`<@${user.id}>: I can't save messages that don't contain any text, so the message you just tagged won't be included in your quote.`);
            return;
        }

        // Start off this index at -1
        let currentActiveQuoteIndex = -1;
        // If it exists, find the quote object in the activeQuoteObjects array
        // that the user who reacted is currently constructing
        for (var i = 0; i < activeQuoteObjects.length; i++) {
            if (activeQuoteObjects[i].quoteAdderObject.toString() === user.toString()) {
                currentActiveQuoteIndex = i;
                break;
            }
        }

        // This message is posted right after a new user starts constructing a new quote.
        let quoteContinueMessage = getQuoteContinueMessage(user.id);
        
        if (currentActiveQuoteIndex === -1) {
            // This user is adding a new quote!
            console.log(user.toString() + " has started adding a new quote...");
            
            // Tell the user how to continue their quote, then push a new QuoteObject
            // to the activeQuoteObjects array to keep track of it
            reaction.message.channel.send(quoteContinueMessage)
            .then(message => {
                currentActiveQuoteIndex = activeQuoteObjects.push(new QuoteObject(
                    user,
                    reaction.message.guild.id,
                    reaction.message.channel.id,
                    reaction.message,
                    message.id)
                ) - 1;

                updateEndQuoteMessage(reaction.message.channel, activeQuoteObjects[currentActiveQuoteIndex]);
            });
        } else {
            // This user is updating an existing quote!
            console.log(user.toString() + " is updating an existing quote with internal index " + currentActiveQuoteIndex + "...");
            // Add the message that they reacted to to the relevant `QuoteObject` in `activeQuoteObjects`
            activeQuoteObjects[currentActiveQuoteIndex].messageObjectsInQuote.push(reaction.message);
            updateEndQuoteMessage(reaction.message.channel, activeQuoteObjects[currentActiveQuoteIndex]);
        }
    } else if (reaction.emoji.name === "🔚") {
        // The user reacted to a message with the "END" emoji...maybe they want to end a quote?
        let currentActiveQuoteIndex = -1;
        // If it exists, find the quote object in the activeQuoteObjects array
        // that the user who reacted is currently constructing
        for (var i = 0; i < activeQuoteObjects.length; i++) {
            if (activeQuoteObjects[i].endQuoteMessageID === reaction.message.id) {
                currentActiveQuoteIndex = i;
                break;
            }
        }
        
        // If the currentActiveQuoteIndex is still at -1, that means the user isn't ending a quote,
        // and just happened to react to a message with the "END" emoji.
        if (currentActiveQuoteIndex > -1) {
            // The user who reacted is finishing up an active quote
            console.log(user.toString() + " has finished adding a new quote...");
            var currentQuoteObject = activeQuoteObjects[i];
            let formattedQuote = formatQuote(currentQuoteObject);
            
            // Save the quote to the database
            var quote = {
                userWhoAdded: activeQuoteObjects[i].quoteAdderObject.toString(),
                guild: activeQuoteObjects[i].quoteGuild,
                channel: activeQuoteObjects[i].quoteChannel,
                quote: formattedQuote
            }
            var id = bot.setQuote.run(quote).lastInsertRowid;
            reaction.message.channel.send("Quote added to database with ID " + id);
            
            // Remove the current QuoteObject from the activeQuoteObjects array
            activeQuoteObjects.splice(currentActiveQuoteIndex, 1);
        }
    }
});
