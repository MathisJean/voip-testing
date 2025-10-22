const axios = require("axios");
const WebSocket = require("ws");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { get_agents, STATUS } = require("./agent_script");
const { channel } = require("diagnostics_channel");

const ARI_URL = "http://localhost:8088/ari";
const auth = { username: "ari_user", password: "strongpassword" };

let queue = [];
const processing_eta = 120;

//Connecting to the ARI server
function connect(){
  const ws = new WebSocket(`${ARI_URL}/events?api_key=${auth.username}:${auth.password}&app=myapp`);

  ws.on("open", () =>
  {
    console.log("Connected to ARI");
  });

  ws.on("message", async (data) =>
  {   
    const event = JSON.parse(data);
    const channelId = event.channel?.id;

    if(!channelId)
    {
      console.log("No channel ID in this event type:", event.type);
      return;
    }

    console.log("ARI event:", event.type);

    if(event.type === "StasisStart")
    {
      answer_call(channelId);

      await play_audio(channelId, "welcome")

      console.log("Incoming call from", event.channel.caller.number);

      if(queue.length > 0)
      {
        //Add to queue
        add_queue(channelId);
      }
      else
      {
        for(let agent of get_agents())
        {
          if(agent.status != STATUS.AVAILABLE) continue;

          const call = await ws.bridge.create({type: 'mixing'});

          await call.addChannel({channel: channelId});
          await call.addChannel({channel: agent.id});
        }
      }
    }

    if(event.type === "StasisEnd")
    {
      remove_queue(channelId);
    }

    if(event.type === "ChannelDtmfReceived")
    {
      const digit = event.digit;

      console.log(`Caller pressed: ${digit}`);

        if(digit === "1")
        {
          queue_length(channelId);
        }
    }
  });

  ws.on("close", () =>
  {
    console.log("Connection closed");
  });

  ws.on("error", (err) =>
  {
    console.error("WebSocket error:", err);
  });
}

async function answer_call(channelId)
{
  try
  {
    await axios.post(
      `${ARI_URL}/channels/${channelId}/answer`,
      {},
      { auth }
    );
    console.log(`Call ${channelId} answered`);
  } 
  catch(err)
  {
    console.error("Error answering call:", err);
  }
}

function add_queue(channelId)
{
  queue.push(channelId);
}

function remove_queue()
{
  queue.shift();
}

function queue_length(channelId)
{
  let queue_size = queue.length;
  let queue_pos = queue.indexOf(channelId) + 1

  let eta = Math.max(((queue_pos / agents) * processing_eta), processing_eta)

  console.log("You are " + queue_pos + " out of " + queue_size + " in the queue. ETA : " + eta)
}

async function play_audio(channelId, audio_file)
{
  try
  {
    await axios.post(
      `${ARI_URL}/channels/${channelId}/play`,
      { media: `sound:${audio_file}` },
      { auth }
    );
  }
  catch(err)
  {
    console.error("Error playing audio:", err);
  }
}

connect();
