const AriClient = require('ari-client');
const { STATUS } = require("./agent_script");

const ARI_URL = "http://localhost:8088/ari";
const auth = { username: "ari_user", password: "strongpassword" };

let queue = [];
const processing_eta = 120;

const agents = [
  { channelId: null, status: STATUS.AVAILABLE, endpoint: '1002-agent' }
];

const pending_calls = new Map();

AriClient.connect(ARI_URL, auth.username, auth.password)
.then(client =>
{
    client.start('myapp');
    console.log("Connected to ARI");

    client.on('disconnect', () =>
    {
        console.log("Connection closed");
    });

    client.on('error', (err) => 
    {
        console.error("WebSocket error:", err);
    });

    client.on('StasisStart', async (event, channel) =>
    {
        console.log('New channel:', channel.name);
        await channel.answer();

        //Agent logic
        if(channel.name.includes('agent'))
        {
            //Agent joined, check if someone was waiting for them
            const pending = [...pending_calls.values()].find(p => !p.bridged && channel.name.split('/')[1].includes(p.agentEndpoint));
            
            if(pending)
            {
                const bridge = await client.bridges.create({ type: 'mixing' });
                await bridge.addChannel({ channel: pending.caller.id });
                await bridge.addChannel({ channel: channel.id });

                //Wait a bit for Asterisk to register the channels
                await new Promise(res => setTimeout(res, 50));

                pending.bridged = true;

                console.log(`Connected caller ${pending.caller.name} to agent ${channel.name}`);
            }
            return;
        }

        //Client logic
        connect_client(channel, client)
    });

    client.on('StasisEnd', async (event, channel) =>
    {
        console.log(`Channel left Stasis: ${channel.name}`);

        try
        {
            //Fetch all active bridges
            const bridges = await client.bridges.list();

            for(const bridge of bridges)
            {
                //Get channel IDs
                const bridge_details = await client.bridges.get({ bridgeId: bridge.id });
                const bridge_channels = bridge_details.channels;

                console.log(bridge_channels, channel.id)

                if(!bridge_channels.includes(channel.id)) continue;
                if(bridge_channels.length === 0) continue; //Skip empty bridge

                for(const bridge_channel_id of bridge_channels)
                {
                    try
                    {
                        const c = await client.channels.get({ channelId: bridge_channel_id });
                        await c.hangup();
                        console.log(`Hung up remaining channel ${bridge_channel_id}`);
                    }
                    catch(err)
                    {
                        console.log(`Failed to hang up ${bridge_channel_id}:`, err.message);
                    }    
                }

                //Destroy bridge
                await bridge.destroy();
                console.log(`Destroyed bridge ${bridge.id}`);
            }
        }
        catch(err)
        {
            console.log('Error cleaning up bridge:', err);
        }

        //Agent logic
        if(channel.name.includes('agent'))
        {
            const agent = agents.find(a => channel.name.includes(a.endpoint));
            if(agent) agent.status = STATUS.AVAILABLE;

            if(queue.length > 0) connect_client(queue[0], client)

            return;
        }

        //Client logic
        if (pending_calls.has(channel.id)) pending_calls.delete(channel.id);
        remove_queue(channel);
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

    let eta = Math.max(((queue_pos / load_agents(client).length) * processing_eta), processing_eta)

    console.log("You are " + queue_pos + " out of " + queue_size + " in the queue. ETA : " + eta)
}

async function connect_client(channel, client)
{
    console.log("Connecting to client")

    //Caller logic
    const agent = agents.find(a => a.status === STATUS.AVAILABLE);

    if(!agent)
    {
        console.log('No available agents, adding to queue');
        if(!queue.includes(channel)) add_queue(channel);
        return;
    }

    remove_queue(channel);

    pending_calls.set(channel.id, { caller: channel, agentEndpoint: agent.endpoint, bridged: false });
    agent.status = STATUS.BUSY;

    //Dial agent
    await client.channels.originate(
    {
        endpoint: `PJSIP/${agent.endpoint}`,
        app: 'myapp',
    });
}