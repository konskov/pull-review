module.exports = function Lock(options) {
  options = options || {};
  var ttl = Math.max(0, options.ttl || 60);

  var locks = {};

  return function isLocked (key) {
    if (!locks[key]) {
      locks[key] = new Date();

      return {
        isLocked: false
      };
    }

    var now = new Date();
    var msDiff = now.getTime() - (locks[key].getTime() + (ttl * 1000));

    if (msDiff < 0) {
      return {
        isLocked: true
      };
    }

    delete locks[key];
    return {
      isLocked: false
    };
  }
};
