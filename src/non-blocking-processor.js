import log from "./log";

export default function (commands, shouldStop) {
    const totalCommands = commands.length;
    const startTime = performance.now();
    let lastProgressTime = startTime;
    
    const process = function () {
        if (!commands.length) {
            const totalTime = performance.now() - startTime;
            return log(`Processing finished in ${totalTime.toFixed(2)}ms.`);
        }

        if (shouldStop && shouldStop())
            return log("Processing stopped.");

        const command = commands.shift();
        command();

        const remaining = commands.length;
        const completed = totalCommands - remaining;
        
        // Show progress every 50 commands or every 2 seconds
        const now = performance.now();
        if (remaining % 50 === 0 && remaining > 0 && (now - lastProgressTime) > 2000) {
            const progress = ((completed / totalCommands) * 100).toFixed(1);
            const elapsed = now - startTime;
            const estimatedTotal = elapsed * (totalCommands / completed);
            const estimatedRemaining = estimatedTotal - elapsed;
            
            log(`${progress}% complete (${remaining} commands remaining, ~${(estimatedRemaining/1000).toFixed(1)}s left)`);
            lastProgressTime = now;
        }

        setTimeout(process, 0);
    };

    log(`Processing ${commands.length} commands...`);
    process();
};
