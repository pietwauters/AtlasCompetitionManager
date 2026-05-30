const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Strip = sequelize.define('Strip', {
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'idle'
    },
    state: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'idle'
    },
    network_state: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'offline'
    }
  }, {
    tableName: 'strips',
    timestamps: false
  });
  return Strip;
};
