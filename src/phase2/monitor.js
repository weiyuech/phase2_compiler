/**
 * Phase 2 Monitoring Module
 * 
 * Provides enhanced visibility into the system's performance and state transitions.
 */

export class Phase2Monitor {
  constructor({ robot, tour, llm }) {
    this.robot = robot;
    this.tour = tour;
    this.llm = llm;
    this.logs = [];
    this.startTime = Date.now();

    this._setupHooks();
  }

  _setupHooks() {
    // 1. Robot Performance
    this.robot.on('heartbeat', (msg) => {
      const battery = msg.system?.battery;
      if (battery < 25) {
        this._record('LOW_BATTERY', { battery });
      }
    });

    // 2. Goal Tracking
    this.robot.on('goal-reached', (data) => {
      this._record('GOAL_REACHED', data);
    });

    // 3. Tour State
    this.tour.on('list-changed', (items) => {
      this._record('TOUR_LIST_UPDATE', { count: items.length });
    });

    console.log('[Phase 2] [Monitor] Active and recording...');
  }

  _record(event, data) {
    const entry = {
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      event,
      data
    };
    this.logs.push(entry);
    
    // Also log to console with prefix for visibility
    console.log(`[Phase 2] [EVENT] [${entry.event}]`, JSON.stringify(data));
    
    // Keep only last 100 logs in memory
    if (this.logs.length > 100) this.logs.shift();
  }

  getSummary() {
    return {
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      totalEvents: this.logs.length,
      lastEvent: this.logs[this.logs.length - 1]
    };
  }
}
