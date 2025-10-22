const AriClient = require('ari-client');
const { STATUS, load_agents } = require("./agent_script");

const ARI_URL = "http://localhost:8088/ari";
const AUTH = { username: "ari_user", password: "strongpassword" };

let queue = []; //TODO: Change array -> map
const PROCESSING_ETA = 120; //Temp var

//Temp var
const AGENTS = [
  { channelId: null, status: STATUS.AVAILABLE, endpoint: '1002-agent' }
];

const PENDING_CALLS = new Map();
let is_agent;

//Connect to Asterisk server
AriClient.connect(ARI_URL, AUTH.username, AUTH.password)
.then(client =>
{
    client.start('myapp');
    console.log("Connected to ARI");

    //Log on disconnect
    client.on('disconnect', () =>
    {
        console.log("Connection closed");
    });

    //Log Asterisk server error
    client.on('error', (err) => 
    {
        console.error("WebSocket error:", err);
    });

    client.on('StasisStart', async (event, channel) =>
    {
        //If softphone is called from the server
        is_agent = event.args[0] === "dialed"

        //Run client logic
        if(!is_agent)
        {
            client_logic(client, channel);
        }
    });

    client.on("ChannelDtmfReceived", (event, channel) =>
    {
      const digit = event.digit;

      console.log(`Caller pressed: ${digit}`);

        if(digit === "1")
        {
          queue_length(channel.id, client);
        }
    })
});

async function client_logic(client, channel)
{
    //No agents online
    if(AGENTS.length <= 0) console.log("No agents online, please call again later"); //TODO: Add open hours

    //Find an available agent
    const AGENT = AGENTS.find(a => a.status === STATUS.AVAILABLE);

    //No available agents -> add to queue
    if(!AGENT)
    {
        console.log('No available agents, adding to queue');
        if(!queue.includes(channel)) add_queue(channel);
        return;
    }

    PENDING_CALLS.set(channel.id, { caller: channel, agentEndpoint: AGENT.endpoint, bridged: false });
    AGENT.status = STATUS.BUSY;

    //Declare agent channel to acces it from client side
    let agent_channel

    //Dial agent
    try
    {
        agent_channel = await client.channels.originate({
            endpoint: `PJSIP/${AGENT.endpoint}`,
            app: 'myapp',
            appArgs: 'dialed',
            callerId: 'Support Agent'
        });
    }
    catch(err)
    {
        console.error('Failed to originate agent call:', err.error);
        AGENT.status = STATUS.AVAILABLE; //Free up agent
        channel.hangup().catch( () => {} );
        return;
    }

    //Remove channel from queue once connected
    remove_queue(channel);

    //Hangup agent when client ends call
    channel.on('StasisEnd', async () =>
    {
        if(agent_channel) await agent_channel.hangup().catch(() => {});

        AGENT.status = STATUS.AVAILABLE;
    });

    //When agent is connected, add channels to bridge
    agent_channel.on('StasisStart', async () =>
    {
        //Creates a bridge for communications
        let bridge = await client.bridges.create({type: 'mixing'});

        //Destroy bridge on end of call
        agent_channel.on('StasisEnd', async () =>
        {
            await bridge.destroy();
        });

        await channel.answer();
        await bridge.addChannel({channel: channel.id});        
        await bridge.addChannel({channel: agent_channel.id});        
    });

    //Hangup client when agent ends call
    agent_channel.on('ChannelDestroyed', async () =>
    {
        await channel.hangup().catch( () => {} );

        remove_queue(channel)
    });
}

function add_queue(channel)
{
    queue.push(channel);
}

function remove_queue(channel)
{
    queue = queue.filter(c => c.id !== channel.id);
}

function queue_length(channel, client)
{
    let queue_size = queue.length;
    let queue_pos = queue.indexOf(channel) + 1

    let eta = Math.max(((queue_pos / load_agents(client).length) * PROCESSING_ETA), PROCESSING_ETA)

    console.log("You are " + queue_pos + " out of " + queue_size + " in the queue. ETA : " + eta)
}